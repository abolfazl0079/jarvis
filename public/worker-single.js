// ═══════════════════════════════════════════════════════════════
//  JARVIS — provider adapters
//  هر chat adapter یک async generator است که دلتای متن yield می‌کند.
// ═══════════════════════════════════════════════════════════════

export const MODEL_DEFS = {
  gemini: {
    label: "Gemini 3.6 Flash",
    color: "#00e5ff",
    model: "gemini-3.6-flash",
  },
  groq: {
    label: "Groq · GPT-OSS 120B",
    color: "#4ade80",
    model: "openai/gpt-oss-120b",
  },
  openrouter: {
    label: "OpenRouter · Free",
    color: "#a78bfa",
    model: null, // به‌صورت داینامیک انتخاب می‌شود (مدل‌های free مدام عوض می‌شوند)
  },
  cfai: {
    label: "Cloudflare Workers AI",
    color: "#fbbf24",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
};

export const CONSENSUS_MODEL = "gemini-flash-lite-latest";
export const STT_MODEL = "gemini-3.6-flash";
export const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
export const GROQ_STT_MODEL = "whisper-large-v3-turbo";

export function systemPrompt() {
  const d = new Date().toLocaleDateString("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  return [
    "تو «جاریس» هستی؛ دستیار هوشمند، سریع و همه‌کاره‌ی شخصی کاربر (مثل J.A.R.V.I.S از فیلم‌های مرد آهنی).",
    "قوانین:",
    "- همیشه به فارسی، با لحن صمیمی، منظم و حرفه‌ای جواب بده؛ مگر کاربر زبان دیگری خواسته باشد.",
    "- جواب‌ها کوتاه، دقیق و کاربردی باشند؛ در صورت نیاز از لیست‌های کوتاه استفاده کن.",
    "- اگر مطمئن نیستی، صادقانه بگو و حدس نزن.",
    `امروز: ${d}. کاربر فارسی‌زبان و در هلند (اروپا) است.`,
  ].join("\n");
}

// ─── Parsing SSE ──────────────────────────────────────────────
async function* sseData(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") yield d;
      }
    }
  }
}

// ─── Gemini (streaming) ───────────────────────────────────────
export async function* chatGemini(key, model, messages, signal) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal,
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 250)}`);
  }
  for await (const data of sseData(res.body)) {
    try {
      const j = JSON.parse(data);
      const parts = j?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) if (p.text && !p.thought) yield p.text;
    } catch {
      /* ignore malformed chunk */
    }
  }
}

// ─── OpenAI-compatible (Groq & OpenRouter, streaming) ─────────
export async function* chatOpenAI(baseUrl, key, model, messages, signal, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt() }, ...messages],
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 250)}`);
  }
  for await (const data of sseData(res.body)) {
    try {
      const j = JSON.parse(data);
      const delta = j?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      /* ignore */
    }
  }
}

// ─── OpenRouter: dynamic free-model selection ─────────────────
const OR_PREFS = [
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-lightning:free",
];
let orCache = null;
// فهرست مدل‌های :free با اولویت (برای fallback روی 429)
export async function resolveOpenRouterCandidates(signal) {
  if (orCache && Date.now() - orCache.ts < 6 * 3600 * 1000) return orCache.list;
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const j = await res.json();
  const free = (j.data || []).map((m) => m.id).filter((id) => id.endsWith(":free"));
  const list = [
    ...OR_PREFS.filter((p) => free.includes(p)),
    ...free.filter((f) => !OR_PREFS.includes(f)),
  ];
  if (list.length) orCache = { list, ts: Date.now() };
  return list;
}
export async function resolveOpenRouterModel(signal) {
  const list = await resolveOpenRouterCandidates(signal);
  return list[0] || null;
}

// ─── Cloudflare Workers AI (non-streaming) ────────────────────
export async function chatCfAI(env, model, messages, signal) {
  if (!env || !env.AI) {
    throw new Error("Workers AI فقط در نسخه‌ی دپلوی‌شده فعال است (env.AI در dev محلی نیست)");
  }
  const res = await env.AI.run(
    model,
    {
      messages: [{ role: "system", content: systemPrompt() }, ...messages],
      temperature: 0.7,
      max_tokens: 2048,
    },
    { signal }
  );
  return typeof res.response === "string" ? res.response : "";
}

// ─── Speech-to-Text ───────────────────────────────────────────
export async function sttGemini(key, { data, mime }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${STT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mime, data } },
              {
                text:
                  "متن این ضبط صوتی را دقیق و کامل به فارسی بنویس. فقط متن را بنویس؛ هیچ توضیح یا نشانه‌ی اضافی نده. اگر صدا به زبان دیگری بود، ترجمه‌ی فارسی و طبیعی بنویس.",
              },
            ],
          },
        ],
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini STT ${res.status}`);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text)
    .join("")
    .trim();
}

export async function sttGroq(key, b64, mime) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "audio.webm");
  form.append("model", GROQ_STT_MODEL);
  form.append("response_format", "text");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}`);
  return (await res.text()).trim();
}

// ─── Text-to-Speech ───────────────────────────────────────────
export async function ttsGemini(key, text) {
  let lastErr;
  for (const model of TTS_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
            },
          }),
        }
      );
      if (!res.ok) {
        const t = await res.text();
        lastErr = new Error(`TTS ${model} ${res.status}: ${t.slice(0, 150)}`);
        if (res.status === 404) continue;
        throw lastErr;
      }
      const j = await res.json();
      const part = (j.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData);
      if (!part?.inlineData?.data) {
        lastErr = new Error("no audio in TTS response");
        continue;
      }
      return {
        audioBase64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "audio/L16",
        sampleRate: 24000,
      };
    } catch (e) {
      lastErr = e;
      if (!String(e.message || e).includes("404")) throw e;
    }
  }
  throw lastErr || new Error("TTS not available");
}


// ───────────────────────────────────────────────────────────
//  Worker entry (router)
// ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
//  JARVIS — Cloudflare Worker
//  • سرو کردن فرانت‌اند (static assets)
//  • /api/chat  → چند مدل همزمان (fan-out) با SSE + پاسخ نهایی (consensus)
//  • /api/stt   → تبدیل صدا به متن (Gemini، پشتیبان: Groq Whisper)
//  • /api/tts   → تبدیل متن به صدا (Gemini TTS)
// ═══════════════════════════════════════════════════════════════

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

// ─── صفحهٔ تشخیصی وقتی assets وصل نیست ────────────────────────
function assetsMissingPage(env) {
  const keys = Object.keys(env).join("، ");
  const ok = "ok";
  const bad = "err";
  const mark = (b) => (b ? `<span class="${ok}">✓</span>` : `<span class="${bad}">✗</span>`);
  return new Response(
    `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>جاریس — اتصال فایل‌های سایت</title>
<style>
body{font-family:Vazirmatn,Tahoma,system-ui,sans-serif;background:radial-gradient(900px 600px at 70% -10%,#07203f 0%,#030b1f 50%,#010409 100%);color:#d7f4ff;line-height:2;min-height:100vh;margin:0}
.wrap{max-width:720px;margin:0 auto;padding:40px 18px}
h1{color:#fff;font-size:21px}
.panel{border:1px solid rgba(0,229,255,.25);border-radius:18px;padding:20px;background:rgba(8,24,48,.55);margin-top:16px}
.ok{color:#4ade80;font-weight:700}.err{color:#ff7b7b;font-weight:700}.amber{color:#ffb300}
code{direction:ltr;unicode-bidi:embed;background:#0a1c33;border:1px solid rgba(0,229,255,.2);border-radius:6px;padding:1px 8px;font-size:12.5px;color:#fff}
.steps{counter-reset:s;list-style:none;padding:0;margin:8px 0 0}
.steps li{position:relative;padding:8px 34px 8px 0;font-size:14px}
.steps li::before{counter-increment:s;content:counter(s,persian);position:absolute;inset-inline-start:0;top:10px;width:24px;height:24px;border-radius:50%;background:#00c8e6;color:#031018;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px}
</style></head>
<body><div class="wrap">
<h1>📦 مغز جاریس روشن است — فقط «بدن» (فایل‌های سایت) وصل نشده</h1>
<p>خبر خوب: سرور و کلیدها <b class="ok">کاملاً سالم</b> هستند (اپی‌آی جواب می‌دهد). فقط فایل‌های داخل پوشهٔ <code>public</code> به این Worker متصل نیستند.</p>
<div class="panel">
  <p class="amber" style="margin:0">بررسی خودکار وضعیت:</p>
  <p style="margin:4px 0 0">فایل‌های سایت (ASSETS): ${mark(env.ASSETS)} &nbsp;·&nbsp; Workers AI: ${mark(env.AI)} &nbsp;·&nbsp; کلیدها: Gemini ${mark(env.GEMINI_API_KEY)} Groq ${mark(env.GROQ_API_KEY)} OpenRouter ${mark(env.OPENROUTER_API_KEY)}</p>
</div>
<div class="panel">
  <p class="amber" style="margin:0">راه‌حل — بدون کد، فقط درگ‌ودراپ:</p>
  <ol class="steps">
    <li>در داشبورد کلودفلر، وارد <b>Settings</b> کار <b>jarvis</b> شو</li>
    <li>بخش <b>Static assets</b> را باز کن</li>
    <li>روی <b>Upload assets</b> بزن و <b>محتویات</b> پوشهٔ <code>public</code> را درگ کن: فایل <code>index.html</code> به‌همراه پوشه‌های <code>css</code>، <code>js</code> و <code>fonts</code></li>
    <li>دکمهٔ <b>Deploy</b> را بزن و این صفحه را دوباره باز کن 🎉</li>
  </ol>
</div>
<p style="font-size:12.5px;color:#7fa3c2">Binding‌های موجود روی این Worker: <code>${keys}</code></p>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
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
    // بقیه‌ی مسیرها → فایل‌های استاتیک (اگر وصل نباشد، صفحهٔ راهنما به‌جای خطا)
    try {
      if (env.ASSETS) return await env.ASSETS.fetch(request);
    } catch {
      /* fall through */
    }
    return assetsMissingPage(env);
  },
};
