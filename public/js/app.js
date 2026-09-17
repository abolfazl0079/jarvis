/* ═══════════════════════════════════════════════
   JARVIS — app: chat + council + SSE + settings
   ═══════════════════════════════════════════════ */
(function () {
  const $ = (s) => document.querySelector(s);
  const chatEl = $("#chat");
  const input = $("#input");
  const btnSend = $("#btn-send");
  const btnMic = $("#btn-mic");
  const statusText = $("#status-text");
  const statusPill = $("#status-pill");
  const modelBar = $("#model-bar");
  const SETTINGS_KEY = "jarvis-settings-v2";
  const DEFAULT_MODELS = { gemini: true, groq: true, openrouter: true, cfai: true, deepseek: true };

  const MODEL_META = {
    gemini: { label: "Gemini", color: "#00e5ff" },
    groq: { label: "Groq", color: "#4ade80" },
    openrouter: { label: "OpenRouter", color: "#a78bfa" },
    cfai: { label: "CF AI", color: "#fbbf24" },
    deepseek: { label: "DeepSeek", color: "#60a5fa" },
  };

  let settings = {
    tts: false, // پاسخ صوتی فقط وقتی خودت بخواهی (دکمهٔ 🔊)
    cloudTts: false,
    autoListen: false,
    models: Object.assign({}, DEFAULT_MODELS),
  };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    Object.assign(settings, stored);
    settings.models = Object.assign(Object.assign({}, DEFAULT_MODELS), stored.models || {});
  } catch {}
  const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const messages = []; // {role, content}
  let busy = false;

  // ── status ──
  function setStatus(s) {
    const map = {
      idle: ["آماده", "idle"],
      listening: ["در حال شنیدن…", "listening"],
      processing: ["در حال فهمیدن…", "processing"],
      thinking: ["در حال تفکر…", "thinking"],
      speaking: ["در حال گفتن", "speaking"],
      error: ["خطا", "idle"],
    };
    const [txt, hud] = map[s] || map.idle;
    statusText.textContent = txt;
    statusPill.dataset.state = hud;
    JHUD.setState(hud);
  }

  // ── helpers ──
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
  function scrollBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function activeModels() {
    return Object.keys(settings.models).filter((k) => settings.models[k]);
  }

  function updateHudModels() {
    JHUD.setModels(activeModels().map((id) => ({ id, label: MODEL_META[id].label, color: MODEL_META[id].color })));
  }

  // ── model chips ──
  function renderModelBar() {
    modelBar.innerHTML = "";
    for (const [id, meta] of Object.entries(MODEL_META)) {
      const on = settings.models[id];
      const chip = document.createElement("span");
      chip.className = "chip" + (on ? "" : " off");
      chip.style.setProperty("--c", meta.color);
      chip.innerHTML = `<i></i>${meta.label}`;
      chip.title = on ? "فعال — کلیک برای غیرفعال‌کردن" : "غیرفعال — کلیک برای فعال‌کردن";
      chip.onclick = () => {
        settings.models[id] = !on;
        save();
        renderModelBar();
        renderSettingsModels();
      };
      modelBar.appendChild(chip);
    }
    updateHudModels();
  }

  // ── chat rendering ──
  function addUser(text) {
    const row = el("div", "msg user");
    row.appendChild(el("div", "bubble", escapeHtml(text)));
    chatEl.appendChild(row);
    scrollBottom();
  }

  function addAi(text) {
    const row = el("div", "msg ai");
    row.appendChild(el("div", "bubble", text));
    chatEl.appendChild(row);
    scrollBottom();
  }

  function addCouncil(modelIds) {
    const wrap = el("div", "turn");
    const grid = el("div", "council");
    const cards = {};
    for (const id of modelIds) {
      const meta = MODEL_META[id];
      const card = el("div", "card");
      card.style.setProperty("--c", meta.color);
      card.innerHTML = `<div class="card-head"><i></i><b>${meta.label}</b><span class="card-status">در حال پاسخ…</span></div><div class="card-body"></div>`;
      grid.appendChild(card);
      cards[id] = {
        card,
        body: card.querySelector(".card-body"),
        status: card.querySelector(".card-status"),
        text: "",
      };
    }
    wrap.appendChild(grid);
    const consensus = el("div", "consensus hidden");
    consensus.innerHTML = `<div class="cons-head">⚡ پاسخ نهایی جاریس</div><div class="cons-body"></div>`;
    wrap.appendChild(consensus);
    const actions = el("div", "turn-actions");
    const hear = el("button", "hear-btn", "🔊 شنیدن پاسخ");
    hear.disabled = true;
    actions.appendChild(hear);
    wrap.appendChild(actions);
    chatEl.appendChild(wrap);
    scrollBottom();
    return { cards, consensus, consBody: consensus.querySelector(".cons-body"), hear };
  }

  // ── SSE client ──
  async function streamChat(payload, handlers) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        handlers[event] && handlers[event](j);
      }
    }
  }

  // ── main ask flow ──
  async function ask(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    JVoice.stopMic();
    JVoice.stopSpeaking();
    const models = activeModels();
    if (!models.length) {
      addAi("⚠ هیچ مدل فعالی نیست — از دکمه‌های بالای می‌دان یا ⚙ تنظیمات، حداقل یک مدل را فعال کن.");
      return;
    }
    busy = true;
    input.value = "";
    autosize();
    addUser(text);
    messages.push({ role: "user", content: text });
    const turn = addCouncil(models);
    const { cards, consensus, consBody } = turn;
    setStatus("thinking");
    models.forEach((id) => JHUD.setModelState(id, "active"));
    turn.hear.onclick = () => {
      if (!turn.hearText) return;
      setStatus("speaking");
      JVoice.speak(turn.hearText, { cloud: settings.cloudTts, onEnd: () => setStatus("idle") });
    };
    let finalText = "";
    let firstAnswer = "";

    try {
      await streamChat(
        { messages: messages.slice(-12), models, consensus: true },
        {
          chunk: (j) => {
            const c = cards[j.model];
            if (!c) return;
            c.text += j.delta;
            c.body.innerHTML = escapeHtml(c.text);
            if (c.status.textContent === "در حال پاسخ…") c.status.textContent = "پاسخ می‌دهد…";
            scrollBottom();
          },
          done: (j) => {
            const c = cards[j.model];
            if (!c) return;
            c.status.textContent = "✓ کامل";
            JHUD.setModelState(j.model, "done");
            if (j.text && !firstAnswer) firstAnswer = j.text;
            if (j.text) { turn.hearText = j.text; turn.hear.disabled = false; }
          },
          error: (j) => {
            const c = cards[j.model];
            if (!c) return;
            c.card.classList.add("error");
            c.status.textContent = "خطا";
            c.body.innerHTML = `<span class="err">${escapeHtml(j.error)}</span>`;
            JHUD.setModelState(j.model, "error");
          },
          consensus: (j) => {
            consensus.classList.remove("hidden");
            consBody.innerHTML = escapeHtml(j.text);
            finalText = j.text;
            turn.hearText = j.text;
            turn.hear.disabled = false;
            scrollBottom();
          },
          consensus_error: (j) => {
            addAi(`<span class="err">⚠ ساختن پاسخ نهایی ناموفق بود: ${escapeHtml(j.error)}</span>`);
          },
          end: () => {},
        }
      );
    } catch (e) {
      for (const id of models) {
        const c = cards[id];
        if (c.status.textContent !== "✓ کامل") {
          c.card.classList.add("error");
          c.status.textContent = "خطا";
          c.body.innerHTML = `<span class="err">${escapeHtml(String(e.message || e))}</span>`;
        }
      }
    }

    const reply = finalText || firstAnswer;
    if (reply) messages.push({ role: "assistant", content: reply });

    if (settings.tts && reply) {
      setStatus("speaking");
      JVoice.speak(reply, {
        cloud: settings.cloudTts,
        onEnd: afterReply,
      });
    } else {
      afterReply();
    }

    function afterReply() {
      setStatus("idle");
      busy = false;
      if (settings.autoListen) {
        JVoice.startMic(
          (t) => {
            if (t) ask(t);
          },
          (s) => {
            if (s === "listening" || s === "processing") setStatus(s);
            else if (!JVoice.isSpeaking()) setStatus("idle");
          }
        );
      }
    }
  }

  // ── composer ──
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input.value);
    }
  });
  btnSend.onclick = () => ask(input.value);

  // ── mic ──
  btnMic.onclick = () => {
    if (JVoice.isRecording()) {
      JVoice.stopMic();
      if (!busy) setStatus("idle");
      return;
    }
    if (busy) {
      addAi("⏳ هنوز در حال پردازش سؤال قبلی‌ام…");
      return;
    }
    JVoice.startMic(
      (t) => {
        if (t) ask(t);
        else setStatus("idle");
      },
      (s) => {
        if (!busy) setStatus(s);
      }
    );
  };
  setInterval(() => btnMic.classList.toggle("rec", JVoice.isRecording()), 250);

  // ── settings modal ──
  const modal = $("#settings");
  $("#btn-settings").onclick = () => {
    syncSettingsInputs();
    loadHealth();
    modal.classList.remove("hidden");
  };
  $("#btn-close-settings").onclick = () => modal.classList.add("hidden");
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });

  function syncSettingsInputs() {
    $("#opt-tts").checked = settings.tts;
    $("#opt-cloudtts").checked = settings.cloudTts;
    $("#opt-autolisten").checked = settings.autoListen;
  }
  $("#opt-tts").onchange = (e) => {
    settings.tts = e.target.checked;
    save();
  };
  $("#opt-cloudtts").onchange = (e) => {
    settings.cloudTts = e.target.checked;
    save();
  };
  $("#opt-autolisten").onchange = (e) => {
    settings.autoListen = e.target.checked;
    save();
  };

  function renderSettingsModels() {
    const box = $("#opt-models");
    box.innerHTML = "";
    for (const [id, meta] of Object.entries(MODEL_META)) {
      const row = document.createElement("label");
      row.className = "row";
      row.innerHTML = `<span style="color:${meta.color}">● ${meta.label}</span><input type="checkbox" data-m="${id}" ${
        settings.models[id] ? "checked" : ""
      } />`;
      box.appendChild(row);
    }
    box.querySelectorAll("input[data-m]").forEach((inp) => {
      inp.onchange = () => {
        settings.models[inp.dataset.m] = inp.checked;
        save();
        renderModelBar();
      };
    });
  }

  async function loadHealth() {
    const box = $("#model-status");
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      const m = j.models || {};
      box.innerHTML =
        "وضعیت کلیدهای سرور: " +
        (m.gemini ? "Gemini ✓ " : "Gemini ✗ ") +
        (m.groq ? "Groq ✓ " : "Groq ✗ ") +
        (m.openrouter ? "OpenRouter ✓ " : "OpenRouter ✗ ") +
        (m.cfai ? "Cloudflare AI ✓" : "Cloudflare AI (فقط نسخه دپلوی‌شده)");
    } catch {
      box.textContent = "⚠ Worker در دسترس نیست. برای اجرای محلی: npm run dev";
    }
  }

  // ── init ──
  JVoice.setLevelHook((v) => JHUD.setLevel(v));
  renderModelBar();
  renderSettingsModels();
  addAi(
    "سلام! من <b>جاریس</b> هستم — دستیار هوشمندت. 🛡️<br>بنویس یا روی 🎙 بزن و حرف بزن. مدل‌های فعال همه <b>همزمان</b> جواب می‌دهند و در پایان یک پاسخ نهاییِ یکپارچه می‌گیری."
  );
  loadHealth();
  setStatus("idle");
  autosize();
})();
