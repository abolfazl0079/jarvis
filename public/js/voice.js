/* ═══════════════════════════════════════════════
   JARVIS — voice: STT (mic → /api/stt) + TTS (browser / cloud)
   ═══════════════════════════════════════════════ */
(function () {
  const st = {
    stream: null,
    recorder: null,
    chunks: [],
    audioCtx: null,
    analyser: null,
    dataArr: null,
    micTimer: null,
    ttsTimer: null,
    cancel: null,
    sr: null,
  };
  let levelHook = null;

  function b64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  function cleanupMic() {
    if (st.micTimer) {
      clearInterval(st.micTimer);
      st.micTimer = null;
    }
    if (st.stream) {
      st.stream.getTracks().forEach((t) => t.stop());
      st.stream = null;
    }
    if (st.audioCtx) {
      st.audioCtx.close().catch(() => {});
      st.audioCtx = null;
    }
    st.analyser = null;
    st.recorder = null;
  }

  // پشتیبان: Web Speech API مرورگر
  function webSpeechFallback(onText, onState) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      onState("error");
      setTimeout(() => onState("idle"), 600);
      return;
    }
    const r = new SR();
    r.lang = "fa-IR";
    r.interimResults = false;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    r.onresult = (e) => {
      finalText = e.results[e.results.length - 1][0].transcript;
    };
    r.onend = () => {
      onState("idle");
      if (finalText) onText(finalText.trim());
    };
    r.onerror = () => onState("idle");
    st.sr = r;
    try {
      r.start();
    } catch {
      onState("idle");
    }
  }

  function startMic(onText, onState) {
    if (st.recorder && st.recorder.state !== "inactive") {
      stopMic();
      return Promise.resolve();
    }
    if (st.sr) {
      try {
        st.sr.abort();
      } catch {}
      st.sr = null;
    }
    onState("listening");
    return navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        st.stream = stream;
        st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = st.audioCtx.createMediaStreamSource(stream);
        st.analyser = st.audioCtx.createAnalyser();
        st.analyser.fftSize = 512;
        src.connect(st.analyser);
        st.dataArr = new Uint8Array(st.analyser.fftSize);
        st.chunks = [];
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        st.recorder = new MediaRecorder(stream, { mimeType: mime });
        st.recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) st.chunks.push(e.data);
        };
        st.recorder.onstop = async () => {
          cleanupMic();
          onState("processing");
          if (!st.chunks.length) {
            onState("idle");
            return;
          }
          try {
            const blob = new Blob(st.chunks, { type: mime.split(";")[0] });
            const data = await b64(blob);
            const r = await fetch("/api/stt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ audio: data, mime: "audio/webm" }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.text) throw new Error(j.error || "STT failed");
            onState("idle");
            onText(j.text);
          } catch {
            onState("error");
            setTimeout(() => onState("idle"), 900);
          }
        };
        st.recorder.start(250);
        st.micTimer = setInterval(() => {
          if (!st.analyser) return;
          st.analyser.getByteTimeDomainData(st.dataArr);
          let s = 0;
          for (let i = 0; i < st.dataArr.length; i++) {
            const v = (st.dataArr[i] - 128) / 128;
            s += v * v;
          }
          if (levelHook) levelHook(Math.min(1, Math.sqrt(s / st.dataArr.length) * 3.4));
        }, 33);
      })
      .catch(() => webSpeechFallback(onText, onState));
  }

  function stopMic() {
    if (st.recorder && st.recorder.state !== "inactive") st.recorder.stop();
    else cleanupMic();
  }

  function stopSpeaking() {
    if (st.cancel) {
      try {
        st.cancel();
      } catch {}
      st.cancel = null;
    }
    if (st.ttsTimer) {
      clearInterval(st.ttsTimer);
      st.ttsTimer = null;
    }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function speakBrowser(text, opts = {}) {
    if (!("speechSynthesis" in window)) {
      opts.onEnd && opts.onEnd();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const fa =
      voices.find((v) => v.lang === "fa-IR") ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("fa"));
    if (fa) u.voice = fa;
    u.lang = "fa-IR";
    u.rate = 1.02;
    u.pitch = 0.95;
    u.onend = () => opts.onEnd && opts.onEnd();
    u.onerror = () => opts.onEnd && opts.onEnd();
    st.cancel = () => speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function playPcm(j, opts = {}) {
    const bin = atob(j.audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer);
    const rate = j.sampleRate || 24000;
    const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
    const buf = actx.createBuffer(1, Math.max(1, i16.length), rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length && i < ch.length; i++) ch[i] = i16[i] / 32768;
    const src = actx.createBufferSource();
    src.buffer = buf;
    const an = actx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    an.connect(actx.destination);
    const data = new Uint8Array(an.fftSize);
    st.ttsTimer = setInterval(() => {
      an.getByteTimeDomainData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        s += v * v;
      }
      if (levelHook) levelHook(Math.min(1, Math.sqrt(s / data.length) * 3));
    }, 33);
    src.onended = () => {
      if (st.ttsTimer) {
        clearInterval(st.ttsTimer);
        st.ttsTimer = null;
      }
      opts.onEnd && opts.onEnd();
    };
    src.start();
    st.cancel = () => {
      try {
        src.stop();
      } catch {}
    };
  }

  function speak(text, opts = {}) {
    stopSpeaking();
    if (!text) return;
    if (opts.cloud) {
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (!j.audioBase64) throw new Error("no audio");
          playPcm(j, opts);
        })
        .catch(() => speakBrowser(text, opts));
    } else {
      speakBrowser(text, opts);
    }
  }

  window.JVoice = {
    startMic,
    stopMic,
    speak,
    stopSpeaking,
    isRecording: () => !!(st.recorder && st.recorder.state !== "inactive"),
    isSpeaking: () => !!st.cancel,
    setLevelHook: (fn) => {
      levelHook = fn;
    },
  };

  // صداها ممکن است دیر لود شوند
  if ("speechSynthesis" in window) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }
})();
