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
    label: "Cloudflare Workers AI · GLM-4.7 Flash",
    color: "#fbbf24",
    model: "@cf/zai-org/glm-4.7-flash",
    via: "cfai",
  },
  deepseek: {
    label: "DeepSeek R1 Distill 32B (Workers AI)",
    color: "#60a5fa",
    model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    via: "cfai",
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
export async function* chatCfAI(env, model, messages, signal) {
  if (!env || !env.AI) {
    throw new Error("Workers AI فقط در نسخه‌ی دپلوی‌شده فعال است (env.AI در dev محلی نیست)");
  }
  const msgs = [{ role: "system", content: systemPrompt() }, ...messages];
  let got = false;
  try {
    const stream = await env.AI.run(
      model,
      { messages: msgs, temperature: 0.7, max_tokens: 2048, stream: true },
      { signal }
    );
    for await (const data of sseData(stream)) {
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (delta) {
          got = true;
          yield delta;
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    if (!got) throw e;
  }
  if (!got) {
    const res = await env.AI.run(model, { messages: msgs, temperature: 0.7, max_tokens: 2048 }, { signal });
    const full = typeof res.response === "string" ? res.response : "";
    if (full) yield full;
  }
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
