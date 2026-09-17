/* ═══════════════════════════════════════════════
   JARVIS — HUD canvas (arc reactor + rings + waveform)
   states: idle | listening | processing | thinking | speaking
   ═══════════════════════════════════════════════ */
(function () {
  const canvas = document.getElementById("hud");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0;

  const S = {
    state: "idle",
    level: 0,
    lastLevelAt: 0,
    speed: 0.1,
    t: 0,
    col: [0, 229, 255],
  };

  const SPEEDS = {
    idle: 0.1,
    listening: 0.45,
    processing: 0.45,
    thinking: 1.1,
    speaking: 0.6,
  };
  const COLORS = {
    idle: [0, 229, 255],
    listening: [64, 240, 255],
    processing: [64, 240, 255],
    thinking: [255, 179, 0],
    speaking: [125, 249, 255],
  };

  // پس‌زمینه‌ی ذرات
  const particles = [];
  for (let i = 0; i < 70; i++) {
    particles.push({
      a: Math.random() * Math.PI * 2,
      r: 0.3 + Math.random() * 0.72,
      s: (0.02 + Math.random() * 0.06) * (Math.random() < 0.5 ? 1 : -1),
      sz: 0.5 + Math.random() * 1.7,
      tw: Math.random() * Math.PI * 2,
    });
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(50, rect.width);
    H = Math.max(50, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  const css = (a) => `rgba(${S.col[0] | 0},${S.col[1] | 0},${S.col[2] | 0},${a})`;

  function tick(dt) {
    S.t += dt;
    const targetSpeed = SPEEDS[S.state] ?? 0.1;
    S.speed += (targetSpeed - S.speed) * Math.min(1, dt * 3);
    const target = COLORS[S.state] || COLORS.idle;
    for (let i = 0; i < 3; i++) S.col[i] += (target[i] - S.col[i]) * Math.min(1, dt * 4);
    // اتلاف سطح صدا وقتی سیگنال جدیدی نمی‌آید
    if (performance.now() - S.lastLevelAt > 160) S.level *= Math.pow(0.02, dt);
    if (S.level < 0.001) S.level = 0;
  }

  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2;
    const rot = S.t * S.speed;
    const breathe = Math.sin(S.t * (S.state === "idle" ? 1.1 : 2.2));

    // ── ذرات ──
    for (const p of particles) {
      p.a += p.s * dt * (0.5 + S.speed * 2);
      const rr = p.r * R * (1 + 0.025 * Math.sin(S.t * 2 + p.tw));
      const x = cx + Math.cos(p.a) * rr;
      const y = cy + Math.sin(p.a) * rr * 0.92;
      const al = (0.12 + 0.3 * (0.5 + 0.5 * Math.sin(S.t * 2.5 + p.tw))) * (0.5 + S.speed);
      ctx.fillStyle = css(Math.min(1, al));
      ctx.beginPath();
      ctx.arc(x, y, p.sz, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── حلقه بیرونی خط‌چین ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot * 0.5);
    ctx.strokeStyle = css(0.5);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([16, 24]);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ── حلقه تیک‌ها ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rot * 0.7);
    ctx.strokeStyle = css(0.45);
    ctx.lineWidth = 1;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const len = i % 6 === 0 ? 9 : 4;
      const r1 = R * 0.385;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * (r1 + len), Math.sin(a) * (r1 + len));
      ctx.stroke();
    }
    ctx.restore();

    // ── سه کمان چرخان ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot * 1.15);
    ctx.strokeStyle = css(0.85);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let k = 0; k < 3; k++) {
      const a0 = (k / 3) * Math.PI * 2 + rot * 0.35;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.3, a0, a0 + Math.PI * 0.42);
      ctx.stroke();
    }
    ctx.restore();

    // ── حلقه ویو‌فورم (صدا) ──
    if (S.level > 0.02) {
      const N = 90;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 - Math.PI / 2 + rot * 0.25;
        const wob = 0.45 + 0.55 * Math.abs(Math.sin(S.t * 6.5 + i * 1.9));
        const len = 2 + 26 * S.level * wob;
        const r1 = R * 0.52;
        ctx.strokeStyle = css(0.2 + 0.7 * S.level * wob);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * (r1 + len), Math.sin(a) * (r1 + len));
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── هسته (آرک راکتور) ──
    const coreR = R * 0.16 * (1 + 0.045 * breathe + 0.12 * S.level);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.7);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.22, css(0.85));
    g.addColorStop(0.55, css(0.2));
    g.addColorStop(1, css(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = css(0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.stroke();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
    draw(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.JHUD = {
    setState(s) {
      S.state = s || "idle";
    },
    setLevel(v) {
      S.level = Math.max(S.level, Math.min(1, v));
      S.lastLevelAt = performance.now();
    },
  };
})();
