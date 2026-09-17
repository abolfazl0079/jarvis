// ═══════════════════════════════════════════════════════════════
//  JARVIS — Cloudflare Worker
//  • سرو کردن فرانت‌اند (static assets)
//  • /api/chat  → چند مدل همزمان (fan-out) با SSE + پاسخ نهایی (consensus)
//  • /api/stt   → تبدیل صدا به متن (Gemini، پشتیبان: Groq Whisper)
//  • /api/tts   → تبدیل متن به صدا (Gemini TTS)
// ═══════════════════════════════════════════════════════════════
import {
  MODEL_DEFS,
  CONSENSUS_MODEL,
  systemPrompt,
  chatGemini,
  chatOpenAI,
  chatCfAI,
  resolveOpenRouterCandidates,
  sttGemini,
  sttGroq,
  ttsGemini,
} from "./providers.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// ─── Consensus (پاسخ نهایی ادغام‌شده) ─────────────────────────
async function consensusAnswer(env, question, answersText) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini key not set");
  const prompt = [
    "تو «جاریس» هستی. کاربر این سؤال را پرسید:",
    "---",
    question,
    "---",
    "چند مدل هوش مصنوعی این پاسخ‌ها را دادند:",
    answersText,
    "",
    "پاسخ‌ها را مقایسه کن و یک پاسخ نهایی، یکپارچه، کامل و دقیق به فارسی بنویس که بهترین قسمت همه‌ی پاسخ‌ها را جمع کند. اگر بین پاسخ‌ها اختلاف مهمی هست، در یک جمله به آن اشاره کن. فقط خودِ پاسخ نهایی را بنویس.",
  ].join("\n");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONSENSUS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Consensus ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text || "")
    .join("")
    .trim();
}

// ─── /api/chat — fan-out به چند مدل همزمان ────────────────────
function handleChat(request, env) {
  return request
    .json()
    .catch(() => ({}))
    .then((payload) => {
      payload = payload || {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const consensus = payload.consensus !== false;
      const wanted = (
        Array.isArray(payload.models) && payload.models.length ? payload.models : Object.keys(MODEL_DEFS)
      ).filter((m) => MODEL_DEFS[m]);
      if (!wanted.length) return json(400, { error: "no valid models" });

      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event, data) => {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          const results = {};
          send("start", { models: wanted });

          await Promise.all(
            wanted.map(async (name) => {
              const def = MODEL_DEFS[name];
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(), 60000);
              let text = "";
              try {
                if (name === "gemini") {
                  if (!env.GEMINI_API_KEY) throw new Error("کلید Gemini تنظیم نشده (GEMINI_API_KEY)");
                  for await (const d of chatGemini(env.GEMINI_API_KEY, def.model, messages, ac.signal)) {
                    text += d;
                    send("chunk", { model: name, delta: d });
                  }
                } else if (name === "groq") {
                  if (!env.GROQ_API_KEY) throw new Error("کلید Groq تنظیم نشده (GROQ_API_KEY)");
                  for await (const d of chatOpenAI("https://api.groq.com/openai/v1", env.GROQ_API_KEY, def.model, messages, ac.signal)) {
                    text += d;
                    send("chunk", { model: name, delta: d });
                  }
                } else if (name === "openrouter") {
                  if (!env.OPENROUTER_API_KEY) throw new Error("کلید OpenRouter تنظیم نشده (OPENROUTER_API_KEY)");
                  const cands = await resolveOpenRouterCandidates(ac.signal);
                  if (!cands.length) throw new Error("مدل رایگان OpenRouter در دسترس نیست");
                  let last429 = null;
                  for (const model of cands.slice(0, 4)) {
                    let succeeded = false;
                    try {
                      for await (const d of chatOpenAI("https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY, model, messages, ac.signal, {
                        "HTTP-Referer": request.url,
                        "X-Title": "Jarvis",
                      })) {
                        text += d;
                        send("chunk", { model: name, delta: d });
                      }
                      succeeded = !!text.trim();
                    } catch (e) {
                      if (text) throw e; // بخشی از پاسخ stream شده — بازنشانی نداریم
                      if (String((e && e.message) || "").includes("429")) {
                        last429 = e;
                        continue; // مدل بعدی
                      }
                      throw e;
                    }
                    if (succeeded) {
                      last429 = null;
                      break;
                    }
                    // پاسخ خالی — مدل بعدی را امتحان کن
                    last429 = last429 || new Error("empty response");
                  }
                  if (last429 && !text.trim()) {
                    throw new Error("مدل‌های رایگان OpenRouter موقتاً مشغول‌اند (rate limit)");
                  }
                } else if (name === "cfai") {
                  const full = await chatCfAI(env, def.model, messages, ac.signal);
                  if (full) {
                    text = full;
                    send("chunk", { model: name, delta: full });
                  }
                }
                results[name] = text;
                send("done", { model: name, text });
              } catch (e) {
                const msg =
                  e && e.name === "AbortError"
                    ? "زمان‌بندی تمام شد (timeout)"
                    : String((e && e.message) || e).slice(0, 300);
                send("error", { model: name, error: msg });
                if (text) {
                  results[name] = text;
                  send("done", { model: name, text, partial: true });
                }
              } finally {
                clearTimeout(timer);
              }
            })
          );

          // ── پاسخ نهایی (consensus) ──
          if (consensus) {
            const ok = Object.keys(results).filter((k) => (results[k] || "").trim().length > 2);
            if (ok.length) {
              try {
                send("consensus_start", {});
                const q = [...messages].reverse().find((m) => m.role === "user" && m.content)?.content || "";
                const answers = ok.map((k) => `### ${MODEL_DEFS[k].label}:\n${results[k]}`).join("\n\n");
                const ctext = await consensusAnswer(env, q, answers);
                results.__consensus = ctext;
                send("consensus", { text: ctext });
              } catch (e) {
                send("consensus_error", { error: String((e && e.message) || e).slice(0, 300) });
              }
            }
          }

          send("end", {});
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          ...CORS,
        },
      });
    });
}

// ─── /api/stt — صدا به متن ─────────────────────────────────────
async function handleStt(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "bad json" });
  }
  const { audio, mime = "audio/webm" } = payload;
  if (!audio) return json(400, { error: "no audio" });
  try {
    if (env.GEMINI_API_KEY) {
      const text = await sttGemini(env.GEMINI_API_KEY, { data: audio, mime });
      if (text) return json(200, { text, provider: "gemini" });
    }
  } catch {
    /* fall through */
  }
  try {
    if (env.GROQ_API_KEY) {
      const text = await sttGroq(env.GROQ_API_KEY, audio, mime);
      if (text) return json(200, { text, provider: "groq-whisper" });
    }
  } catch {
    /* fall through */
  }
  return json(502, { error: "STT failed: no provider could transcribe" });
}

// ─── /api/tts — متن به صدا ─────────────────────────────────────
async function handleTts(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "bad json" });
  }
  const text = (payload.text || "").slice(0, 4000);
  if (!text.trim()) return json(400, { error: "no text" });
  if (!env.GEMINI_API_KEY) return json(501, { error: "Gemini key not set" });
  try {
    const r = await ttsGemini(env.GEMINI_API_KEY, text);
    return json(200, r);
  } catch (e) {
    return json(502, { error: String((e && e.message) || e).slice(0, 200) });
  }
}

// ─── /api/health ───────────────────────────────────────────────
function handleHealth(env) {
  return json(200, {
    ok: true,
    models: {
      gemini: !!env.GEMINI_API_KEY,
      groq: !!env.GROQ_API_KEY,
      openrouter: !!env.OPENROUTER_API_KEY,
      cfai: !!env.AI,
    },
    systemPromptPreview: systemPrompt().slice(0, 80),
  });
}

// ─── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === "POST" && url.pathname === "/api/chat") return handleChat(request, env);
    if (request.method === "POST" && url.pathname === "/api/stt") return handleStt(request, env);
    if (request.method === "POST" && url.pathname === "/api/tts") return handleTts(request, env);
    if (request.method === "GET" && url.pathname === "/api/health") return handleHealth(env);
    // بقیه‌ی مسیرها → فایل‌های استاتیک
    return env.ASSETS.fetch(request);
  },
};
