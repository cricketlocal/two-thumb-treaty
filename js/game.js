/**
 * Two-Thumb Treaty
 * Local multiplayer: left thumb vs right thumb on one phone.
 */

(() => {
  "use strict";

  const MODES = {
    balloon: {
      id: "balloon",
      name: "Balloon Treaty",
      blurb: "Left keeps the balloon up. Right tries to pop it.",
      leftHelp: "TAP / HOLD left side to blow the balloon UP",
      rightHelp: "TAP right side to launch spikes",
      duration: 30,
    },
    bridge: {
      id: "bridge",
      name: "Bridge & Bomb",
      blurb: "Left repairs the bridge. Right drops holes.",
      leftHelp: "TAP to repair bridge segments",
      rightHelp: "TAP to drop a bomb / hole",
      duration: 28,
    },
    hungry: {
      id: "hungry",
      name: "Hungry vs Healthy",
      blurb: "Feed your foods into the mouth. Highest score wins.",
      leftHelp: "DRAG greens into the mouth",
      rightHelp: "DRAG junk into the mouth",
      duration: 32,
    },
  };

  const state = {
    screen: "home",
    modeId: "balloon",
    swapped: false, // if true, physical left zone plays Right role
    series: { left: 0, right: 0, target: 2 }, // first to 2 = best of 3
    seriesEnabled: true,
    running: false,
    timeLeft: 0,
    winner: null, // 'left' | 'right' | 'draw' (logical sides)
    raf: 0,
    lastTs: 0,
    // input
    pointers: new Map(), // id -> {x,y,side,holding}
    // mode data reset per round
    game: null,
    particles: [],
    shake: 0,
  };

  // DOM
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    home: $("#screen-home"),
    modes: $("#screen-modes"),
    how: $("#screen-how"),
    brief: $("#screen-brief"),
    play: $("#screen-play"),
    result: $("#screen-result"),
  };
  const canvas = $("#game-canvas");
  const ctx = canvas.getContext("2d");
  const overlay = $("#play-overlay");
  const overlayCount = $("#overlay-count");
  const overlaySub = $("#overlay-sub");
  const timerEl = $("#hud-timer");
  const modeLabelEl = $("#hud-mode");
  const leftHelpEl = $("#left-help");
  const rightHelpEl = $("#right-help");
  const resultTitle = $("#result-title");
  const resultSub = $("#result-sub");
  const seriesPips = $("#series-pips");
  const briefLeft = $("#brief-left");
  const briefRight = $("#brief-right");
  const briefMode = $("#brief-mode");

  // ——— Audio (no assets) ———
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function beep(freq = 440, dur = 0.08, type = "square", gain = 0.04) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  function sfx(name) {
    ensureAudio();
    if (name === "tick") beep(660, 0.06, "square", 0.03);
    if (name === "go") beep(880, 0.12, "sawtooth", 0.05);
    if (name === "pop") {
      beep(120, 0.15, "sawtooth", 0.06);
      beep(80, 0.2, "triangle", 0.05);
    }
    if (name === "win") {
      beep(523, 0.1, "square", 0.04);
      setTimeout(() => beep(659, 0.1, "square", 0.04), 90);
      setTimeout(() => beep(784, 0.18, "square", 0.05), 180);
    }
    if (name === "tap") beep(320, 0.04, "triangle", 0.025);
    if (name === "repair") beep(500, 0.05, "sine", 0.03);
    if (name === "bomb") beep(90, 0.12, "square", 0.05);
    if (name === "score") beep(700, 0.07, "sine", 0.035);
  }

  function haptic(ms = 12) {
    if (navigator.vibrate) navigator.vibrate(ms);
  }

  // ——— Screens ———
  function showScreen(name) {
    state.screen = name;
    Object.entries(screens).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle("active", k === name);
    });
  }

  function logicalSides() {
    // returns which logical role is on physical left/right
    if (!state.swapped) return { physLeft: "left", physRight: "right" };
    return { physLeft: "right", physRight: "left" };
  }

  function roleHelp(mode) {
    const map = logicalSides();
    // physical left help depends on which role is there
    const leftRole = map.physLeft;
    const rightRole = map.physRight;
    return {
      left: leftRole === "left" ? mode.leftHelp : mode.rightHelp,
      right: rightRole === "right" ? mode.rightHelp : mode.leftHelp,
      leftTitle: leftRole === "left" ? "LEFT" : "LEFT (plays RIGHT)",
      rightTitle: rightRole === "right" ? "RIGHT" : "RIGHT (plays LEFT)",
      leftGoal: leftRole === "left" ? goalText(mode, "left") : goalText(mode, "right"),
      rightGoal: rightRole === "right" ? goalText(mode, "right") : goalText(mode, "left"),
    };
  }

  function goalText(mode, role) {
    if (mode.id === "balloon") {
      return role === "left" ? "Keep the balloon alive" : "Pop the balloon";
    }
    if (mode.id === "bridge") {
      return role === "left" ? "Get the runner across" : "Drop them through";
    }
    if (mode.id === "hungry") {
      return role === "left" ? "Feed healthy food" : "Feed junk food";
    }
    return "";
  }

  function updateBrief() {
    const mode = MODES[state.modeId];
    const help = roleHelp(mode);
    briefMode.textContent = mode.name;
    briefLeft.innerHTML = `<h3>${help.leftTitle}</h3><p>${help.leftGoal}</p>`;
    briefRight.innerHTML = `<h3>${help.rightTitle}</h3><p>${help.rightGoal}</p>`;
  }

  function renderSeriesPips() {
    const fill = (el) => {
      if (!el) return;
      el.innerHTML = "";
      for (let i = 0; i < state.series.target; i++) {
        const l = document.createElement("span");
        l.className = "pip" + (i < state.series.left ? " left-win" : "");
        el.appendChild(l);
      }
      const mid = document.createElement("span");
      mid.textContent = "  vs  ";
      mid.style.opacity = "0.5";
      mid.style.fontSize = "0.75rem";
      el.appendChild(mid);
      for (let i = 0; i < state.series.target; i++) {
        const r = document.createElement("span");
        r.className = "pip" + (i < state.series.right ? " right-win" : "");
        el.appendChild(r);
      }
    };
    fill(seriesPips);
    fill(document.getElementById("series-pips-result"));
  }

  // ——— Canvas sizing ———
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function midX() {
    return window.innerWidth / 2;
  }

  function sideOfX(x) {
    return x < midX() ? "physLeft" : "physRight";
  }

  function roleForPhys(phys) {
    const map = logicalSides();
    return phys === "physLeft" ? map.physLeft : map.physRight;
  }

  // ——— Particles ———
  function burst(x, y, color, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 220;
      state.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.5,
        color,
        size: 2 + Math.random() * 4,
      });
    }
  }

  function updateParticles(dt) {
    state.particles = state.particles.filter((p) => {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
      return p.life > 0;
    });
  }

  function drawParticles() {
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ——— Mode setups ———
  function initGame() {
    const mode = MODES[state.modeId];
    state.timeLeft = mode.duration;
    state.winner = null;
    state.particles = [];
    state.shake = 0;
    state.pointers.clear();

    if (mode.id === "balloon") {
      state.game = {
        balloon: {
          x: window.innerWidth / 2,
          y: window.innerHeight * 0.55,
          r: Math.min(42, window.innerWidth * 0.07),
          vy: -20,
          vx: 0,
        },
        wind: 0, // left force upward
        spikes: [],
        popped: false,
      };
    } else if (mode.id === "bridge") {
      const segs = 10;
      state.game = {
        segs,
        health: Array(segs).fill(1), // 0 broken, 1 solid
        runnerX: 0.08,
        runnerY: 0,
        runnerVx: 0.12, // fraction of width per second-ish scaled
        fallen: false,
        finished: false,
        bombCd: 0,
        repairCd: 0,
      };
    } else if (mode.id === "hungry") {
      state.game = {
        foods: [],
        spawnT: 0,
        scores: { left: 0, right: 0 },
        mouth: { x: window.innerWidth / 2, y: window.innerHeight * 0.28, r: 48 },
        drag: null, // {id, foodIndex}
      };
    }
  }

  // ——— Input ———
  function onPointerDown(e) {
    if (!state.running) return;
    canvas.setPointerCapture?.(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const phys = sideOfX(x);
    const role = roleForPhys(phys);
    state.pointers.set(e.pointerId, { x, y, phys, role, holding: true });
    handleTap(role, x, y);
    sfx("tap");
    haptic(8);
  }

  function onPointerMove(e) {
    if (!state.running) return;
    const p = state.pointers.get(e.pointerId);
    if (!p) return;
    const rect = canvas.getBoundingClientRect();
    p.x = e.clientX - rect.left;
    p.y = e.clientY - rect.top;
    // keep role locked to original half for fairness? recompute:
    p.phys = sideOfX(p.x);
    p.role = roleForPhys(p.phys);

    // hungry mode drag is resolved each frame in updateHungryDrag()
  }

  function onPointerUp(e) {
    state.pointers.delete(e.pointerId);
  }

  function leftHolding() {
    for (const p of state.pointers.values()) {
      if (p.role === "left" && p.holding) return true;
    }
    return false;
  }

  function handleTap(role, x, y) {
    const g = state.game;
    if (!g) return;

    if (state.modeId === "balloon" && role === "right" && !g.popped) {
      // launch spike from bottom-right-ish toward balloon
      const fromX = x;
      const fromY = window.innerHeight - 20;
      const bx = g.balloon.x;
      const by = g.balloon.y;
      const dx = bx - fromX;
      const dy = by - fromY;
      const len = Math.hypot(dx, dy) || 1;
      const speed = 520;
      g.spikes.push({
        x: fromX,
        y: fromY,
        vx: (dx / len) * speed,
        vy: (dy / len) * speed,
        life: 1.6,
      });
      sfx("tap");
    }

    if (state.modeId === "bridge") {
      if (role === "left" && g.repairCd <= 0) {
        // repair weakest / random broken-ish
        let idx = g.health.findIndex((h) => h < 1);
        if (idx < 0) idx = Math.floor(Math.random() * g.segs);
        g.health[idx] = Math.min(1, g.health[idx] + 0.45);
        g.repairCd = 0.18;
        sfx("repair");
        burst(
          (idx + 0.5) * (window.innerWidth / g.segs),
          window.innerHeight * 0.62,
          "#7eb6ff",
          8
        );
      }
      if (role === "right" && g.bombCd <= 0) {
        const idx = Math.floor(Math.random() * g.segs);
        g.health[idx] = Math.max(0, g.health[idx] - 0.55);
        g.bombCd = 0.28;
        sfx("bomb");
        state.shake = 0.2;
        burst(
          (idx + 0.5) * (window.innerWidth / g.segs),
          window.innerHeight * 0.62,
          "#ff5a3d",
          14
        );
      }
    }
  }

  // Each frame attach nearest matching food to active pointers
  function updateHungryDrag() {
    const g = state.game;
    if (!g) return;
    const claimed = new Set();
    for (const [pid, p] of state.pointers) {
      let best = -1;
      let bestD = 40;
      for (let i = 0; i < g.foods.length; i++) {
        if (claimed.has(i)) continue;
        const f = g.foods[i];
        if (f.eaten || f.team !== p.role) continue;
        const d = Math.hypot(f.x - p.x, f.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        const f = g.foods[best];
        f.x = p.x;
        f.y = p.y;
        f.held = true;
        claimed.add(best);
        const m = g.mouth;
        if (Math.hypot(f.x - m.x, f.y - m.y) < m.r + f.r * 0.6) {
          f.eaten = true;
          f.held = false;
          g.scores[f.team] += 1;
          sfx("score");
          burst(m.x, m.y, f.team === "left" ? "#2dd4a8" : "#ffd166", 14);
          haptic(12);
        }
      }
    }
    g.foods.forEach((f, i) => {
      if (!claimed.has(i)) f.held = false;
    });
  }

  // ——— Update modes ———
  function updateBalloon(dt) {
    const g = state.game;
    if (g.popped) return;

    // wind from left hold
    g.wind = leftHolding() ? 1 : 0;
    const b = g.balloon;
    const gravity = 160;
    const lift = 380;

    b.vy += gravity * dt;
    b.vy -= g.wind * lift * dt;
    // gentle drift
    b.vx += (Math.sin(performance.now() / 400) * 30 - b.vx) * dt;
    // keep near center-ish with soft bounds
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const minY = 80;
    const maxY = window.innerHeight - 40;
    if (b.y < minY) {
      b.y = minY;
      b.vy *= -0.3;
    }
    if (b.y > maxY) {
      b.y = maxY;
      b.vy = -Math.abs(b.vy) * 0.4;
    }
    const midx = window.innerWidth / 2;
    b.x += (midx - b.x) * 0.4 * dt;
    b.x = Math.max(b.r + 10, Math.min(window.innerWidth - b.r - 10, b.x));

    // spikes
    for (const s of g.spikes) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      if (Math.hypot(s.x - b.x, s.y - b.y) < b.r - 4) {
        g.popped = true;
        state.shake = 0.45;
        burst(b.x, b.y, "#ff7a90", 28);
        burst(b.x, b.y, "#ffffff", 12);
        sfx("pop");
        haptic(40);
        endRound("right"); // logical right pops
        return;
      }
    }
    g.spikes = g.spikes.filter((s) => s.life > 0 && s.y > -40);
  }

  function updateBridge(dt) {
    const g = state.game;
    if (g.fallen || g.finished) return;
    g.bombCd = Math.max(0, g.bombCd - dt);
    g.repairCd = Math.max(0, g.repairCd - dt);

    // slow natural decay for drama
    for (let i = 0; i < g.segs; i++) {
      g.health[i] = Math.max(0, g.health[i] - 0.015 * dt);
    }

    const speed = 0.085; // screen fraction / sec
    g.runnerX += speed * dt;

    const seg = Math.min(g.segs - 1, Math.floor(g.runnerX * g.segs));
    if (g.health[seg] < 0.28) {
      g.fallen = true;
      state.shake = 0.35;
      sfx("pop");
      haptic(30);
      endRound("right");
      return;
    }
    if (g.runnerX >= 0.96) {
      g.finished = true;
      sfx("win");
      endRound("left");
    }
  }

  function updateHungry(dt) {
    const g = state.game;
    g.spawnT -= dt;
    if (g.spawnT <= 0) {
      g.spawnT = 0.55;
      spawnFood();
    }
    for (const f of g.foods) {
      if (f.eaten || f.held) continue;
      f.vy += 40 * dt;
      f.y += f.vy * dt;
      f.x += f.vx * dt;
      if (f.y > window.innerHeight + 40) f.eaten = true; // recycle
    }
    g.foods = g.foods.filter((f) => !f.eaten);
    updateHungryDrag();
  }

  function spawnFood() {
    const g = state.game;
    const team = Math.random() < 0.5 ? "left" : "right";
    const w = window.innerWidth;
    const x =
      team === "left"
        ? 40 + Math.random() * (w / 2 - 80)
        : w / 2 + 40 + Math.random() * (w / 2 - 80);
    const emojis = team === "left" ? ["🥦", "🥕", "🍎", "🥗"] : ["🍔", "🍩", "🍕", "🍟"];
    g.foods.push({
      x,
      y: -30,
      vx: (Math.random() - 0.5) * 20,
      vy: 40 + Math.random() * 40,
      r: 22,
      team,
      emoji: emojis[Math.floor(Math.random() * emojis.length)],
      held: false,
      eaten: false,
    });
  }

  // ——— Draw modes ———
  function drawBalloon() {
    const g = state.game;
    const b = g.balloon;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // ambient
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    for (let i = 0; i < 8; i++) {
      const px = ((i * 97) % w) + (performance.now() / 40) * (i % 2 ? 1 : -1);
      ctx.beginPath();
      ctx.arc(px % w, (i * 80) % h, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // string
    if (!g.popped) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.r - 4);
      ctx.quadraticCurveTo(b.x + 10, b.y + b.r + 40, b.x - 6, b.y + b.r + 70);
      ctx.stroke();

      // balloon body
      const grd = ctx.createRadialGradient(b.x - 10, b.y - 10, 8, b.x, b.y, b.r);
      grd.addColorStop(0, "#ffb4c8");
      grd.addColorStop(1, "#e6395c");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r * 0.9, b.r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(b.x - 12, b.y - 14, 8, 12, -0.5, 0, Math.PI * 2);
      ctx.fill();
      // knot
      ctx.fillStyle = "#c02848";
      ctx.beginPath();
      ctx.moveTo(b.x - 6, b.y + b.r - 6);
      ctx.lineTo(b.x + 6, b.y + b.r - 6);
      ctx.lineTo(b.x, b.y + b.r + 6);
      ctx.fill();
    }

    // wind indicator
    if (g.wind) {
      ctx.fillStyle = "rgba(126,182,255,0.35)";
      for (let i = 0; i < 5; i++) {
        const yy = b.y + 50 + i * 18;
        ctx.fillRect(20, yy, 40 + Math.random() * 30, 4);
      }
    }

    // spikes
    for (const s of g.spikes) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.atan2(s.vy, s.vx));
      ctx.fillStyle = "#ffd166";
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-10, 7);
      ctx.lineTo(-10, -7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBridge() {
    const g = state.game;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bridgeY = h * 0.62;
    const segW = w / g.segs;

    // pylons
    ctx.fillStyle = "#3a4566";
    ctx.fillRect(0, bridgeY + 18, w, h);

    for (let i = 0; i < g.segs; i++) {
      const hp = g.health[i];
      const x = i * segW;
      if (hp <= 0.05) {
        // hole
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(x + 2, bridgeY, segW - 4, 22);
        continue;
      }
      const color =
        hp > 0.6 ? "#8b6b3e" : hp > 0.3 ? "#a85a2a" : "#6b2a2a";
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, bridgeY, segW - 2, 18);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x + 1, bridgeY, segW - 2, 4);
    }

    // runner
    if (!g.fallen) {
      const rx = g.runnerX * w;
      const ry = bridgeY - 18;
      ctx.fillStyle = "#ffd166";
      ctx.beginPath();
      ctx.arc(rx, ry - 16, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7eb6ff";
      ctx.fillRect(rx - 9, ry - 6, 18, 20);
    } else {
      const rx = g.runnerX * w;
      ctx.fillStyle = "rgba(255,90,61,0.8)";
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("💥", rx - 12, bridgeY + 50);
    }

    // finish flag
    ctx.fillStyle = "#2dd4a8";
    ctx.fillRect(w - 18, bridgeY - 70, 6, 70);
    ctx.fillRect(w - 12, bridgeY - 70, 24, 16);
  }

  function drawHungry() {
    const g = state.game;
    const m = g.mouth;

    // mouth
    ctx.fillStyle = "#2a1830";
    ctx.beginPath();
    ctx.ellipse(m.x, m.y, m.r * 1.2, m.r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff6b8a";
    ctx.beginPath();
    ctx.ellipse(m.x, m.y + 4, m.r * 0.85, m.r * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(m.x, m.y - 2, m.r * 0.7, 0.15, Math.PI - 0.15);
    ctx.stroke();

    // scores
    ctx.font = "bold 28px Segoe UI, sans-serif";
    ctx.fillStyle = "#7eb6ff";
    ctx.fillText(String(g.scores.left), 24, 100);
    ctx.fillStyle = "#ff9a84";
    ctx.textAlign = "right";
    ctx.fillText(String(g.scores.right), window.innerWidth - 24, 100);
    ctx.textAlign = "left";

    // foods
    ctx.font = "28px serif";
    for (const f of g.foods) {
      if (f.eaten) continue;
      ctx.fillText(f.emoji, f.x - 14, f.y + 10);
      ctx.strokeStyle = f.team === "left" ? "rgba(126,182,255,0.6)" : "rgba(255,90,61,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ——— Round flow ———
  function endRound(logicalWinner) {
    if (state.winner) return;
    state.winner = logicalWinner;
    state.running = false;

    if (logicalWinner === "left") state.series.left += 1;
    if (logicalWinner === "right") state.series.right += 1;

    setTimeout(() => {
      showResult();
    }, 650);
  }

  function showResult() {
    const w = state.winner;
    resultTitle.className = "winner " + (w || "draw");
    if (w === "left") {
      resultTitle.textContent = "LEFT WINS";
      resultSub.textContent = state.swapped
        ? "Logical Left scored — check who held that side!"
        : "Protectors / builders / greens take the round.";
      sfx("win");
    } else if (w === "right") {
      resultTitle.textContent = "RIGHT WINS";
      resultSub.textContent = state.swapped
        ? "Logical Right scored — check who held that side!"
        : "Poppers / bombers / junk food take the round.";
      sfx("win");
    } else {
      resultTitle.textContent = "DRAW";
      resultSub.textContent = "Timer ran out with no decisive blow.";
    }

    // series complete?
    let seriesMsg = "";
    if (state.seriesEnabled) {
      seriesMsg = ` Series: Left ${state.series.left} – ${state.series.right} Right (first to ${state.series.target})`;
      if (state.series.left >= state.series.target || state.series.right >= state.series.target) {
        seriesMsg +=
          state.series.left > state.series.right
            ? " · LEFT takes the match!"
            : " · RIGHT takes the match!";
      }
    }
    resultSub.textContent += seriesMsg;
    renderSeriesPips();
    showScreen("result");
  }

  function onTimerEnd() {
    if (state.winner) return;
    if (state.modeId === "balloon") {
      // left survives
      endRound("left");
      burst(state.game.balloon.x, state.game.balloon.y, "#7eb6ff", 20);
      sfx("win");
    } else if (state.modeId === "bridge") {
      // if still running, left advantage if past half else right
      const g = state.game;
      if (g.fallen) endRound("right");
      else if (g.finished || g.runnerX > 0.7) endRound("left");
      else endRound("right");
    } else if (state.modeId === "hungry") {
      const s = state.game.scores;
      if (s.left > s.right) endRound("left");
      else if (s.right > s.left) endRound("right");
      else {
        state.winner = "draw";
        state.running = false;
        setTimeout(showResult, 400);
      }
    }
  }

  // ——— Main loop ———
  function frame(ts) {
    if (state.screen !== "play") {
      state.raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.033, (ts - state.lastTs) / 1000 || 0.016);
    state.lastTs = ts;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // shake
    let ox = 0;
    let oy = 0;
    if (state.shake > 0) {
      state.shake -= dt;
      ox = (Math.random() - 0.5) * 12 * state.shake * 4;
      oy = (Math.random() - 0.5) * 12 * state.shake * 4;
    }

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(ox, oy);

    // midline glow
    const grad = ctx.createLinearGradient(w / 2 - 40, 0, w / 2 + 40, 0);
    grad.addColorStop(0, "rgba(61,139,253,0.08)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.06)");
    grad.addColorStop(1, "rgba(255,90,61,0.08)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    if (state.running) {
      state.timeLeft -= dt;
      if (state.timeLeft <= 0) {
        state.timeLeft = 0;
        onTimerEnd();
      }
      if (state.modeId === "balloon") updateBalloon(dt);
      if (state.modeId === "bridge") updateBridge(dt);
      if (state.modeId === "hungry") updateHungry(dt);
      updateParticles(dt);
    }

    if (state.modeId === "balloon") drawBalloon();
    if (state.modeId === "bridge") drawBridge();
    if (state.modeId === "hungry") drawHungry();
    drawParticles();

    ctx.restore();

    timerEl.textContent = Math.ceil(state.timeLeft).toString().padStart(2, "0");
    state.raf = requestAnimationFrame(frame);
  }

  // ——— Flow actions ———
  function startCountdown() {
    const mode = MODES[state.modeId];
    showScreen("play");
    resizeCanvas();
    initGame();
    const help = roleHelp(mode);
    leftHelpEl.textContent = help.left;
    rightHelpEl.textContent = help.right;
    modeLabelEl.textContent = mode.name;
    timerEl.textContent = String(mode.duration);

    overlay.classList.add("show");
    let n = 3;
    overlayCount.textContent = "3";
    overlaySub.textContent = `${help.leftGoal}  ·  vs  ·  ${help.rightGoal}`;
    sfx("tick");

    const tick = () => {
      n -= 1;
      if (n > 0) {
        overlayCount.textContent = String(n);
        sfx("tick");
        setTimeout(tick, 700);
      } else {
        overlayCount.textContent = "GO!";
        sfx("go");
        setTimeout(() => {
          overlay.classList.remove("show");
          state.running = true;
          state.lastTs = performance.now();
        }, 350);
      }
    };
    setTimeout(tick, 700);
  }

  function resetSeries() {
    state.series.left = 0;
    state.series.right = 0;
    renderSeriesPips();
  }

  // ——— Events ———
  function bind() {
    $("#btn-play").addEventListener("click", () => {
      ensureAudio();
      showScreen("modes");
    });
    $("#btn-how").addEventListener("click", () => showScreen("how"));
    $("#btn-how-back").addEventListener("click", () => showScreen("home"));
    $("#btn-modes-back").addEventListener("click", () => showScreen("home"));

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ensureAudio();
        state.modeId = btn.getAttribute("data-mode");
        updateBrief();
        showScreen("brief");
      });
    });

    $("#btn-brief-back").addEventListener("click", () => showScreen("modes"));
    $("#btn-start-round").addEventListener("click", () => {
      ensureAudio();
      startCountdown();
    });

    $("#btn-rematch").addEventListener("click", () => {
      // if series complete, reset series
      if (
        state.series.left >= state.series.target ||
        state.series.right >= state.series.target
      ) {
        resetSeries();
      }
      startCountdown();
    });

    $("#btn-switch").addEventListener("click", () => {
      state.swapped = !state.swapped;
      updateBrief();
      if (
        state.series.left >= state.series.target ||
        state.series.right >= state.series.target
      ) {
        resetSeries();
      }
      startCountdown();
    });

    $("#btn-modes-from-result").addEventListener("click", () => {
      showScreen("modes");
    });

    $("#btn-home").addEventListener("click", () => {
      resetSeries();
      showScreen("home");
    });

    $("#btn-new-series").addEventListener("click", () => {
      resetSeries();
      updateBrief();
      showScreen("brief");
    });

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("resize", () => {
      if (state.screen === "play") resizeCanvas();
    });

    // prevent multi-touch scroll on play
    document.body.addEventListener(
      "touchmove",
      (e) => {
        if (state.screen === "play") e.preventDefault();
      },
      { passive: false }
    );
  }

  // init
  bind();
  renderSeriesPips();
  showScreen("home");
  state.raf = requestAnimationFrame(frame);
})();
