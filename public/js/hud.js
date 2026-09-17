/* ═══════════════════════════════════════════════
   JARVIS — Orb HUD
   کره‌ی چرخان مثل زمین + برق‌های دور آن + گره‌های مدل‌ها
   شاخه‌ها از کره به اطراف و جواب‌ها پایین صفحه.
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
    t: 0,
    speed: 0.3,
    models: [], // {id, label, color, state: idle|active|done|error}
  };
  const SPEEDS = { idle: 0.3, listening: 0.7, processing: 0.7, thinking: 1.5, speaking: 0.8 };
  const ARC_TARGET = { idle: 2, listening: 5, processing: 5, thinking: 13, speaking: 6 };

  // جرقه‌های مداری دور کره
  const orbits = [];
  for (let i = 0; i < 46; i++) {
    orbits.push({
      r: 1.22 + Math.random() * 0.62,
      a: Math.random() * Math.PI * 2,
      s: (0.2 + Math.random() * 0.55) * (Math.random() < 0.5 ? 1 : -1),
      sz: 0.6 + Math.random() * 1.6,
      tw: Math.random() * Math.PI * 2,
    });
  }

  // قوس‌های برق روی پوسته
  let arcs = [];

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(200, rect.width);
    H = Math.max(160, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  const orbR = () => Math.min(W * 0.14, H * 0.24, 105);

  function nodePos(i, n) {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return {
      x: W / 2 + Math.cos(ang) * W * 0.37,
      y: H / 2 + Math.sin(ang) * H * 0.35,
    };
  }

  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function tick(dt) {
    S.t += dt;
    S.speed += ((SPEEDS[S.state] ?? 0.3) - S.speed) * Math.min(1, dt * 3);
    if (performance.now() - S.lastLevelAt > 160) S.level *= Math.pow(0.02, dt);
    if (S.level < 0.001) S.level = 0;

    const target = ARC_TARGET[S.state] ?? 2;
    if (arcs.length < target) arcs.push({ seed: Math.random() * 100 });
    else if (arcs.length > target && Math.random() < 0.15) arcs.pop();

    for (const o of orbits) o.a += o.s * dt * (0.5 + S.speed);
  }

  // ── کره (سبد سیم‌کش زمین‌مانند + چرخش) ──
  function drawOrb() {
    const R = orbR() * (1 + 0.03 * Math.sin(S.t * 1.4) + 0.06 * S.level);
    const cx = W / 2;
    const cy = H / 2;
    const rot = S.t * S.speed;

    // هاله‌ی پشت
    const g0 = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 2.3);
    g0.addColorStop(0, `rgba(0,190,255,${0.26 + S.level * 0.3 + (S.state === "thinking" ? 0.1 : 0)})`);
    g0.addColorStop(1, "rgba(0,190,255,0)");
    ctx.fillStyle = g0;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2.3, 0, Math.PI * 2);
    ctx.fill();

    // بدنه
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, "rgba(90,210,255,0.55)");
    g.addColorStop(0.45, "rgba(25,110,190,0.4)");
    g.addColorStop(1, "rgba(4,25,60,0.95)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // خطوط عرض (موازی)
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(120,230,255,0.38)";
    for (const h of [-0.62, -0.31, 0, 0.31, 0.62]) {
      const rr = Math.sqrt(1 - h * h) * R;
      ctx.beginPath();
      ctx.ellipse(cx, cy + h * R, rr, rr * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // خطوط طول (چرخان — حس چرخش کره)
    for (let k = 0; k < 6; k++) {
      const ph = rot + (k * Math.PI) / 6;
      const rx = Math.abs(Math.cos(ph)) * R;
      const al = 0.14 + 0.3 * Math.abs(Math.cos(ph));
      ctx.strokeStyle = `rgba(140,235,255,${al})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.5, rx), R, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // لبه‌ی درخشان
    ctx.strokeStyle = "rgba(190,245,255,0.9)";
    ctx.lineWidth = 1.6;
    ctx.shadowColor = "rgba(0,229,255,0.9)";
    ctx.shadowBlur = 14 + 24 * S.level + (S.state === "thinking" ? 10 : 0);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    return R;
  }

  // ── برق‌ها (در حالت تحلیل بلرزن) ──
  function rimPoint(a, r, shake) {
    return {
      x: W / 2 + Math.cos(a) * r + (Math.random() - 0.5) * shake,
      y: H / 2 + Math.sin(a) * r + (Math.random() - 0.5) * shake,
    };
  }

  function drawArcs(R) {
    const thinking = S.state === "thinking";
    for (const arc of arcs) {
      const a0 = arc.seed + S.t * 0.4;
      const a1 = a0 + 0.7 + Math.abs(Math.sin(arc.seed * 7.3)) * 1.5;
      const shake = thinking ? 1.8 : 0.5;
      const p0 = rimPoint(a0, R * 1.03, shake);
      const p1 = rimPoint(a1, R * 1.03, shake);
      const segs = 6;
      const amp = (thinking ? 9 : 3.5) + S.level * 8;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      for (let k = 1; k < segs; k++) {
        const f = k / segs;
        const off =
          Math.sin(S.t * (26 + arc.seed * 3) + k * 2.7 + arc.seed * 13) *
          amp *
          Math.sin(f * Math.PI);
        ctx.lineTo(p0.x + dx * f + nx * off, p0.y + dy * f + ny * off);
      }
      ctx.lineTo(p1.x, p1.y);
      const al = Math.min(1, (thinking ? 0.85 : 0.38) + S.level * 0.4);
      ctx.strokeStyle = `rgba(190,245,255,${al})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  // ── جرقه‌های مداری ──
  function drawOrbits(R) {
    for (const o of orbits) {
      const x = W / 2 + Math.cos(o.a) * R * o.r;
      const y = H / 2 + Math.sin(o.a) * R * o.r * 0.94;
      const al =
        (0.14 + 0.4 * (0.5 + 0.5 * Math.sin(S.t * 2.5 + o.tw))) * (0.6 + S.speed);
      ctx.fillStyle = `rgba(160,240,255,${Math.min(1, al)})`;
      ctx.beginPath();
      ctx.arc(x, y, o.sz, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── شاخه‌ها + گره‌های مدل‌ها ──
  function drawModels(R) {
    const n = S.models.length;
    if (!n) return;
    const cx = W / 2;
    const cy = H / 2;
    for (let i = 0; i < n; i++) {
      const m = S.models[i];
      const p = nodePos(i, n);
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const sx = cx + ux * R;
      const sy = cy + uy * R;
      const active = m.state === "active";

      // شاخه‌ی صاعقه‌ای
      const segs = 5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      for (let k = 1; k < segs; k++) {
        const f = k / segs;
        const off = Math.sin(S.t * (8 + i * 3) + k * 3.1 + i * 7) * 4 * Math.sin(f * Math.PI);
        ctx.lineTo(sx + (p.x - sx) * f - uy * off, sy + (p.y - sy) * f + ux * off);
      }
      ctx.lineTo(p.x, p.y);
      const baseAl = active ? 0.8 : m.state === "done" ? 0.55 : m.state === "error" ? 0.8 : 0.26;
      ctx.strokeStyle = m.state === "error" ? `rgba(255,123,123,${baseAl})` : hexA(m.color, baseAl);
      ctx.lineWidth = active ? 2 : 1.2;
      ctx.stroke();

      // جرقه‌ی متحرک روی شاخه هنگام پاسخ
      if (active) {
        const f = (S.t * 1.6 + i * 0.37) % 1;
        const bx = sx + (p.x - sx) * f;
        const by = sy + (p.y - sy) * f;
        ctx.fillStyle = hexA(m.color, 0.95);
        ctx.shadowColor = m.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(bx, by, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // گره
      const pulse = active ? 1 + 0.18 * Math.sin(S.t * 7) : 1;
      const nr = 13 * pulse;
      const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, nr * 2.4);
      gg.addColorStop(0, hexA(m.color, active ? 0.95 : 0.5));
      gg.addColorStop(1, hexA(m.color, 0));
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(p.x, p.y, nr * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#04101f";
      ctx.beginPath();
      ctx.arc(p.x, p.y, nr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = m.state === "error" ? "#ff7b7b" : m.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, nr, 0, Math.PI * 2);
      ctx.stroke();

      ctx.textAlign = "center";
      if (m.state === "done") {
        ctx.fillStyle = m.color;
        ctx.font = "700 13px Vazirmatn, Tahoma";
        ctx.fillText("✓", p.x, p.y + 4.5);
      } else if (m.state === "error") {
        ctx.fillStyle = "#ff7b7b";
        ctx.font = "700 13px Vazirmatn, Tahoma";
        ctx.fillText("✗", p.x, p.y + 4.5);
      }

      // برچسب
      ctx.fillStyle = m.state === "error" ? "rgba(255,123,123,0.9)" : "rgba(215,244,255,0.92)";
      ctx.font = "12px Vazirmatn, Tahoma";
      ctx.fillText(m.label, p.x, p.y + nr + 18);
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
    ctx.clearRect(0, 0, W, H);
    const R = drawOrb();
    drawOrbits(R);
    drawArcs(R);
    drawModels(R);
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
    setModels(list) {
      S.models = (list || []).map((m) => ({ ...m, state: "idle" }));
    },
    setModelState(id, st) {
      const m = S.models.find((x) => x.id === id);
      if (m) m.state = st;
    },
  };
})();
