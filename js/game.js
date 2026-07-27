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
      blurb: "Left steers the wind. Right aims an arc and fires spikes.",
      leftHelp: "HOLD left half: wind follows your finger (↑↓←→)",
      rightHelp: "DRAG to aim the arc · RELEASE to fire",
      duration: 35,
    },
    puck: {
      id: "puck",
      name: "Puck Duel",
      blurb: "Air-hockey on one phone. Score on their goal.",
      leftHelp: "DRAG your paddle · defend left · score right",
      rightHelp: "DRAG your paddle · defend right · score left",
      duration: 45,
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
      return role === "left"
        ? "Steer the wind — keep the balloon alive"
        : "Aim the arc, release to fire spikes";
    }
    if (mode.id === "puck") {
      return role === "left"
        ? "Drive the puck into their goal"
        : "Drive the puck into their goal";
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
      const aim = defaultRightAim();
      state.game = {
        balloon: {
          x: window.innerWidth / 2,
          y: window.innerHeight * 0.5,
          r: Math.min(38, window.innerWidth * 0.065),
          vy: 0,
          vx: 0,
        },
        // wind vector from left player (-1..1-ish)
        windX: 0,
        windY: 0,
        spikes: [],
        spikeCd: 0,
        maxSpikes: 2,
        popped: false,
        // Right aim arc
        aim,
        aiming: false,
      };
    } else if (mode.id === "puck") {
      state.game = createPuckGame();
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

  /** Default aim arc for the logical right player (toward the field). */
  function defaultRightAim() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const map = logicalSides();
    const rightIsPhysRight = map.physRight === "right";
    // Pivot sits on the outer edge of the right player's half
    const pivotX = rightIsPhysRight ? w * 0.9 : w * 0.1;
    const pivotY = h * 0.55;
    // Aim toward screen center
    const angle = Math.atan2(h * 0.45 - pivotY, w * 0.5 - pivotX);
    return {
      pivotX,
      pivotY,
      angle,
      arcRadius: Math.min(w, h) * 0.28,
      // Angle range facing into the playfield
      minAngle: rightIsPhysRight ? -Math.PI * 0.92 : -Math.PI * 0.08,
      maxAngle: rightIsPhysRight ? -Math.PI * 0.08 : Math.PI * 0.08,
      // fix ranges properly below in clampAimAngle
      facingLeft: rightIsPhysRight,
    };
  }

  /** Clamp aim so spikes fire into the field with limited up/down pitch. */
  function clampAimAngle(angle, facingLeft) {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    const maxPitch = 1.2;
    const sin = Math.max(
      -Math.sin(maxPitch),
      Math.min(Math.sin(maxPitch), Math.sin(a))
    );
    const cos = facingLeft
      ? -Math.max(0.2, Math.abs(Math.cos(a)))
      : Math.max(0.2, Math.abs(Math.cos(a)));
    return Math.atan2(sin, cos);
  }

  function aimArcEnds(facingLeft) {
    const maxPitch = 1.2;
    if (facingLeft) {
      // Upper-left → lower-left through straight left (±π)
      return {
        a0: Math.atan2(-Math.sin(maxPitch), -1),
        a1: Math.atan2(Math.sin(maxPitch), -1),
        acw: false, // clockwise through ±π
      };
    }
    // Upper-right → lower-right through straight right (0)
    return {
      a0: Math.atan2(-Math.sin(maxPitch), 1),
      a1: Math.atan2(Math.sin(maxPitch), 1),
      acw: true,
    };
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
    state.pointers.set(e.pointerId, {
      x,
      y,
      phys,
      role,
      holding: true,
      downAt: performance.now(),
      startX: x,
      startY: y,
    });

    // Balloon right: start aiming only (fire on release)
    if (state.modeId === "balloon" && role === "right" && state.game && !state.game.popped) {
      state.game.aiming = true;
      updateRightAimFromPointers();
      sfx("tap");
      haptic(6);
      return;
    }

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

    if (state.modeId === "balloon" && p.role === "right" && state.game) {
      state.game.aiming = true;
      updateRightAimFromPointers();
    }
    // hungry mode drag is resolved each frame in updateHungryDrag()
  }

  function onPointerUp(e) {
    const p = state.pointers.get(e.pointerId);
    if (
      p &&
      state.modeId === "balloon" &&
      p.role === "right" &&
      state.game &&
      !state.game.popped &&
      state.running
    ) {
      updateRightAimFromPointers();
      fireAimedSpike();
      // If no other right pointers, stop aiming highlight
      state.pointers.delete(e.pointerId);
      let stillAiming = false;
      for (const q of state.pointers.values()) {
        if (q.role === "right" && q.holding) stillAiming = true;
      }
      state.game.aiming = stillAiming;
      return;
    }
    state.pointers.delete(e.pointerId);
  }

  function updateRightAimFromPointers() {
    const g = state.game;
    if (!g || !g.aim) return;
    // Refresh pivot in case of rotate/resize
    const base = defaultRightAim();
    g.aim.pivotX = base.pivotX;
    g.aim.pivotY = base.pivotY;
    g.aim.arcRadius = base.arcRadius;
    g.aim.facingLeft = base.facingLeft;

    let finger = null;
    for (const p of state.pointers.values()) {
      if (p.role === "right" && p.holding) {
        finger = p;
        break;
      }
    }
    if (!finger) return;

    // Angle from pivot to finger = aim direction
    const ang = Math.atan2(finger.y - g.aim.pivotY, finger.x - g.aim.pivotX);
    g.aim.angle = clampAimAngle(ang, g.aim.facingLeft);
  }

  function fireAimedSpike() {
    const g = state.game;
    if (!g || g.popped) return;
    if (g.spikeCd > 0) return;
    if (g.spikes.length >= g.maxSpikes) return;

    const { pivotX, pivotY, angle, arcRadius } = g.aim;
    const speed = 340;
    // Spawn at rim of aim arc
    const spawnR = arcRadius * 0.55;
    g.spikes.push({
      x: pivotX + Math.cos(angle) * spawnR,
      y: pivotY + Math.sin(angle) * spawnR,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 2.4,
    });
    g.spikeCd = 0.65;
    sfx("bomb");
    haptic(14);
    burst(
      pivotX + Math.cos(angle) * spawnR,
      pivotY + Math.sin(angle) * spawnR,
      "#ffd166",
      10
    );
  }

  /** Left wind: direction from left-zone center to finger (up/down/left/right). */
  function getLeftWind() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Center of the physical half currently controlled by logical left
    const map = logicalSides();
    const leftIsPhysLeft = map.physLeft === "left";
    const zoneCx = leftIsPhysLeft ? w * 0.25 : w * 0.75;
    const zoneCy = h * 0.55;
    // Dead zone so small finger wobble doesn't fight you
    const dead = Math.min(w, h) * 0.04;
    // Max reach for full power
    const maxR = Math.min(w * 0.22, h * 0.35);

    let wx = 0;
    let wy = 0;
    let any = false;
    for (const p of state.pointers.values()) {
      if (p.role !== "left" || !p.holding) continue;
      any = true;
      let dx = p.x - zoneCx;
      let dy = p.y - zoneCy;
      const dist = Math.hypot(dx, dy);
      if (dist < dead) {
        // Hold near center = gentle float / hover (slight upward bias)
        wx += 0;
        wy += -0.35;
      } else {
        const scale = Math.min(1, (dist - dead) / (maxR - dead));
        wx += (dx / dist) * scale;
        wy += (dy / dist) * scale;
      }
    }
    if (!any) return { x: 0, y: 0, active: false, zoneCx, zoneCy, maxR };
    // Average if multi-touch, clamp
    const len = Math.hypot(wx, wy) || 1;
    if (len > 1) {
      wx /= len;
      wy /= len;
    }
    return { x: wx, y: wy, active: true, zoneCx, zoneCy, maxR };
  }

  function handleTap(role, x, y) {
    const g = state.game;
    if (!g) return;
    // Balloon right fires via aim arc on pointer up (see fireAimedSpike)
    // Puck mode: paddles track fingers continuously in updatePuck
  }

  function createPuckGame() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(34, h * 0.055);
    const layout = puckPaddleLayout(pr);
    return {
      ball: {
        x: w / 2,
        y: h / 2,
        vx: (Math.random() < 0.5 ? -1 : 1) * 180,
        vy: (Math.random() - 0.5) * 120,
        r: Math.min(16, h * 0.028),
      },
      paddles: {
        left: {
          x: layout.left.x,
          y: h / 2,
          r: pr,
          minX: layout.left.minX,
          maxX: layout.left.maxX,
          prevX: layout.left.x,
          prevY: h / 2,
        },
        right: {
          x: layout.right.x,
          y: h / 2,
          r: pr,
          minX: layout.right.minX,
          maxX: layout.right.maxX,
          prevX: layout.right.x,
          prevY: h / 2,
        },
      },
      scores: { left: 0, right: 0 },
      goalToWin: 3,
      serveT: 0.85,
      lastScorer: null,
      flash: 0,
    };
  }

  /** Paddle lanes based on which physical half owns each logical role. */
  function puckPaddleLayout(pr) {
    const w = window.innerWidth;
    const map = logicalSides();
    const leftOnLeft = map.physLeft === "left";
    // Logical left defends the goal on their outer edge
    if (leftOnLeft) {
      return {
        left: {
          x: w * 0.16,
          minX: pr + 8,
          maxX: w * 0.45,
        },
        right: {
          x: w * 0.84,
          minX: w * 0.55,
          maxX: w - pr - 8,
        },
      };
    }
    // Swapped: logical left is on physical right
    return {
      left: {
        x: w * 0.84,
        minX: w * 0.55,
        maxX: w - pr - 8,
      },
      right: {
        x: w * 0.16,
        minX: pr + 8,
        maxX: w * 0.45,
      },
    };
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

    g.spikeCd = Math.max(0, g.spikeCd - dt);
    // Keep aim tracking while finger is down
    updateRightAimFromPointers();

    const wind = getLeftWind();
    g.windX = wind.x;
    g.windY = wind.y;
    g.windActive = wind.active;
    g.windPad = wind;

    const b = g.balloon;
    // Mild gravity so Left must keep managing height
    const gravity = 95;
    const windPower = 520;
    const drag = 1.8;

    b.vy += gravity * dt;
    if (wind.active) {
      b.vx += wind.x * windPower * dt;
      b.vy += wind.y * windPower * dt;
    }
    // Air drag so steering is responsive, not ice-rink
    b.vx *= Math.exp(-drag * dt);
    b.vy *= Math.exp(-drag * dt);
    // Soft speed cap
    const sp = Math.hypot(b.vx, b.vy);
    const maxSp = 420;
    if (sp > maxSp) {
      b.vx = (b.vx / sp) * maxSp;
      b.vy = (b.vy / sp) * maxSp;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const minY = 70;
    const maxY = window.innerHeight - 36;
    const minX = b.r + 8;
    const maxX = window.innerWidth - b.r - 8;
    if (b.y < minY) {
      b.y = minY;
      b.vy *= -0.35;
    }
    if (b.y > maxY) {
      b.y = maxY;
      b.vy = -Math.abs(b.vy) * 0.45;
    }
    if (b.x < minX) {
      b.x = minX;
      b.vx *= -0.4;
    }
    if (b.x > maxX) {
      b.x = maxX;
      b.vx *= -0.4;
    }
    // No center pull — Left must dodge with wind

    // spikes (tighter hit = harder pop)
    const hitR = b.r * 0.72;
    for (const s of g.spikes) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      if (Math.hypot(s.x - b.x, s.y - b.y) < hitR) {
        g.popped = true;
        state.shake = 0.45;
        burst(b.x, b.y, "#ff7a90", 28);
        burst(b.x, b.y, "#ffffff", 12);
        sfx("pop");
        haptic(40);
        endRound("right");
        return;
      }
    }
    g.spikes = g.spikes.filter(
      (s) =>
        s.life > 0 &&
        s.x > -40 &&
        s.y > -40 &&
        s.x < window.innerWidth + 40 &&
        s.y < window.innerHeight + 40
    );
  }

  function updatePuck(dt) {
    const g = state.game;
    if (!g || state.winner) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const b = g.ball;

    g.flash = Math.max(0, g.flash - dt);

    // Track paddles from fingers (logical roles)
    for (const role of ["left", "right"]) {
      const pad = g.paddles[role];
      pad.prevX = pad.x;
      pad.prevY = pad.y;
      let finger = null;
      for (const p of state.pointers.values()) {
        if (p.role === role && p.holding) {
          finger = p;
          break;
        }
      }
      if (finger) {
        // Smooth follow
        pad.x += (finger.x - pad.x) * Math.min(1, 18 * dt);
        pad.y += (finger.y - pad.y) * Math.min(1, 18 * dt);
        pad.x = Math.max(pad.minX, Math.min(pad.maxX, pad.x));
        pad.y = Math.max(pad.r + 8, Math.min(h - pad.r - 8, pad.y));
      }
    }

    // Serve delay after goal
    if (g.serveT > 0) {
      g.serveT -= dt;
      b.x = w / 2;
      b.y = h / 2;
      if (g.serveT <= 0) {
        const dir = g.lastScorer === "left" ? 1 : g.lastScorer === "right" ? -1 : Math.random() < 0.5 ? -1 : 1;
        // Serve toward the player who was scored on
        b.vx = dir * 200;
        b.vy = (Math.random() - 0.5) * 160;
      }
      return;
    }

    // Integrate ball
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Top / bottom walls
    if (b.y < b.r + 6) {
      b.y = b.r + 6;
      b.vy = Math.abs(b.vy) * 0.95;
      sfx("tap");
    }
    if (b.y > h - b.r - 6) {
      b.y = h - b.r - 6;
      b.vy = -Math.abs(b.vy) * 0.95;
      sfx("tap");
    }

    // Side walls (outside goal mouth) bounce; goal mouth scores
    const goalH = h * 0.34;
    const goalTop = (h - goalH) / 2;
    const goalBot = goalTop + goalH;
    const inGoalY = b.y > goalTop && b.y < goalBot;

    // Left edge
    if (b.x < b.r + 4) {
      if (inGoalY) {
        // Goal against the player defending left physical edge — score for opponent of that defender
        scorePuckGoal(defenderRoleAtPhysical("left"));
        return;
      }
      b.x = b.r + 4;
      b.vx = Math.abs(b.vx) * 0.92;
      sfx("tap");
    }
    // Right edge
    if (b.x > w - b.r - 4) {
      if (inGoalY) {
        scorePuckGoal(defenderRoleAtPhysical("right"));
        return;
      }
      b.x = w - b.r - 4;
      b.vx = -Math.abs(b.vx) * 0.92;
      sfx("tap");
    }

    // Paddle collisions
    for (const role of ["left", "right"]) {
      collidePuckPaddle(b, g.paddles[role], dt);
    }

    // Soft speed limits
    const sp = Math.hypot(b.vx, b.vy);
    const maxSp = 620;
    const minSp = 140;
    if (sp > maxSp) {
      b.vx = (b.vx / sp) * maxSp;
      b.vy = (b.vy / sp) * maxSp;
    } else if (sp < minSp && sp > 1) {
      b.vx = (b.vx / sp) * minSp;
      b.vy = (b.vy / sp) * minSp;
    }

    // Light friction
    b.vx *= Math.exp(-0.08 * dt);
    b.vy *= Math.exp(-0.08 * dt);
  }

  /** Which logical role defends a physical outer edge. */
  function defenderRoleAtPhysical(edge) {
    const map = logicalSides();
    // edge 'left' means physical left goal
    if (edge === "left") return map.physLeft;
    return map.physRight;
  }

  function scorePuckGoal(concedingRole) {
    const g = state.game;
    if (!g || state.winner) return;
    // Other role scores
    const scorer = concedingRole === "left" ? "right" : "left";
    g.scores[scorer] += 1;
    g.lastScorer = scorer;
    g.flash = 0.45;
    state.shake = 0.3;
    sfx("score");
    haptic(25);
    burst(g.ball.x, g.ball.y, scorer === "left" ? "#7eb6ff" : "#ff9a84", 22);

    if (g.scores[scorer] >= g.goalToWin) {
      endRound(scorer);
      return;
    }
    g.serveT = 0.9;
    g.ball.vx = 0;
    g.ball.vy = 0;
  }

  function collidePuckPaddle(ball, pad, dt) {
    const dx = ball.x - pad.x;
    const dy = ball.y - pad.y;
    const dist = Math.hypot(dx, dy) || 1;
    const minDist = ball.r + pad.r;
    if (dist >= minDist) return;

    // Separate
    const nx = dx / dist;
    const ny = dy / dist;
    ball.x = pad.x + nx * minDist;
    ball.y = pad.y + ny * minDist;

    // Paddle velocity from movement
    const pvx = (pad.x - pad.prevX) / Math.max(dt, 0.001);
    const pvy = (pad.y - pad.prevY) / Math.max(dt, 0.001);

    // Reflect ball velocity along normal
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= 2 * vn * nx;
      ball.vy -= 2 * vn * ny;
    }
    // Add paddle shove
    ball.vx += pvx * 0.55 + nx * 120;
    ball.vy += pvy * 0.55 + ny * 40;

    sfx("tap");
    haptic(8);
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

    // Wind pad on left player's zone (direction guide)
    if (g.windPad) {
      const { zoneCx, zoneCy, maxR } = g.windPad;
      ctx.strokeStyle = "rgba(126,182,255,0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(zoneCx, zoneCy, maxR * 0.85, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(126,182,255,0.12)";
      ctx.beginPath();
      ctx.arc(zoneCx, zoneCy, 10, 0, Math.PI * 2);
      ctx.fill();
      // Cross guides ↑↓←→
      ctx.strokeStyle = "rgba(126,182,255,0.2)";
      ctx.beginPath();
      ctx.moveTo(zoneCx, zoneCy - maxR * 0.75);
      ctx.lineTo(zoneCx, zoneCy + maxR * 0.75);
      ctx.moveTo(zoneCx - maxR * 0.75, zoneCy);
      ctx.lineTo(zoneCx + maxR * 0.75, zoneCy);
      ctx.stroke();
      ctx.fillStyle = "rgba(126,182,255,0.45)";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("↑", zoneCx, zoneCy - maxR * 0.75 - 6);
      ctx.fillText("↓", zoneCx, zoneCy + maxR * 0.75 + 16);
      ctx.fillText("←", zoneCx - maxR * 0.75 - 12, zoneCy + 5);
      ctx.fillText("→", zoneCx + maxR * 0.75 + 12, zoneCy + 5);
      ctx.textAlign = "left";

      if (g.windActive) {
        const ax = zoneCx + g.windX * maxR * 0.7;
        const ay = zoneCy + g.windY * maxR * 0.7;
        ctx.strokeStyle = "rgba(126,182,255,0.9)";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(zoneCx, zoneCy);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.fillStyle = "#7eb6ff";
        ctx.beginPath();
        ctx.arc(ax, ay, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Right aim arc (protractor + trajectory)
    if (g.aim) {
      const { pivotX, pivotY, angle, arcRadius, facingLeft } = g.aim;
      const { a0, a1, acw } = aimArcEnds(facingLeft);
      const hot = g.aiming || g.spikeCd <= 0;

      // Arc rail
      ctx.beginPath();
      ctx.strokeStyle = hot
        ? "rgba(255,154,132,0.55)"
        : "rgba(255,154,132,0.28)";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.arc(pivotX, pivotY, arcRadius, a0, a1, acw);
      ctx.stroke();

      // Soft wedge fill
      ctx.beginPath();
      ctx.moveTo(pivotX, pivotY);
      ctx.arc(pivotX, pivotY, arcRadius, a0, a1, acw);
      ctx.closePath();
      ctx.fillStyle = g.aiming
        ? "rgba(255,90,61,0.14)"
        : "rgba(255,90,61,0.06)";
      ctx.fill();

      // Pivot cannon
      ctx.fillStyle = "#ff9a84";
      ctx.beginPath();
      ctx.arc(pivotX, pivotY, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Aim needle on arc
      const nx = pivotX + Math.cos(angle) * arcRadius;
      const ny = pivotY + Math.sin(angle) * arcRadius;
      ctx.strokeStyle = g.spikeCd > 0 ? "rgba(255,209,102,0.4)" : "#ffd166";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pivotX, pivotY);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      ctx.fillStyle = g.spikeCd > 0 ? "rgba(255,209,102,0.5)" : "#ffd166";
      ctx.beginPath();
      ctx.arc(nx, ny, 9, 0, Math.PI * 2);
      ctx.fill();

      // Predicted shot line (dashed)
      ctx.save();
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = g.aiming
        ? "rgba(255,209,102,0.75)"
        : "rgba(255,209,102,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pivotX + Math.cos(angle) * 16, pivotY + Math.sin(angle) * 16);
      ctx.lineTo(
        pivotX + Math.cos(angle) * arcRadius * 2.4,
        pivotY + Math.sin(angle) * arcRadius * 2.4
      );
      ctx.stroke();
      ctx.restore();

      // Label
      ctx.fillStyle = "rgba(255,154,132,0.75)";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        g.spikeCd > 0 ? "…" : g.aiming ? "release to fire" : "drag arc to aim",
        pivotX + (facingLeft ? -arcRadius * 0.2 : arcRadius * 0.2),
        pivotY + arcRadius + 22
      );
      ctx.textAlign = "left";
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

      // Wind arrow on balloon
      if (g.windActive && (Math.abs(g.windX) > 0.05 || Math.abs(g.windY) > 0.05)) {
        const ang = Math.atan2(g.windY, g.windX);
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(ang);
        ctx.strokeStyle = "rgba(126,182,255,0.95)";
        ctx.fillStyle = "rgba(126,182,255,0.95)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(b.r + 4, 0);
        ctx.lineTo(b.r + 28, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.r + 32, 0);
        ctx.lineTo(b.r + 20, 7);
        ctx.lineTo(b.r + 20, -7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
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

    // Right cooldown pip
    if (g.spikeCd > 0) {
      ctx.fillStyle = "rgba(255,154,132,0.85)";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = g.aim && g.aim.facingLeft ? "right" : "left";
      const tx = g.aim && g.aim.facingLeft ? w - 16 : 16;
      ctx.fillText("spike reloading…", tx, h - 18);
      ctx.textAlign = "left";
    }
  }

  function drawPuck() {
    const g = state.game;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const goalH = h * 0.34;
    const goalTop = (h - goalH) / 2;

    // Rink floor
    ctx.fillStyle = "rgba(20, 40, 70, 0.55)";
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 12);
    ctx.lineTo(w / 2, h - 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 36, 0, Math.PI * 2);
    ctx.stroke();

    // Goals
    ctx.fillStyle = "rgba(61,139,253,0.22)";
    ctx.fillRect(0, goalTop, 14, goalH);
    ctx.strokeStyle = "rgba(126,182,255,0.7)";
    ctx.lineWidth = 3;
    ctx.strokeRect(1, goalTop, 12, goalH);

    ctx.fillStyle = "rgba(255,90,61,0.22)";
    ctx.fillRect(w - 14, goalTop, 14, goalH);
    ctx.strokeStyle = "rgba(255,154,132,0.7)";
    ctx.strokeRect(w - 13, goalTop, 12, goalH);

    // Goal flash
    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255,209,102,${g.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Scores
    ctx.font = "bold 42px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#7eb6ff";
    ctx.fillText(String(g.scores.left), w * 0.35, 56);
    ctx.fillStyle = "#ff9a84";
    ctx.fillText(String(g.scores.right), w * 0.65, 56);
    ctx.font = "bold 12px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(`first to ${g.goalToWin}`, w / 2, 74);
    ctx.textAlign = "left";

    // Paddles
    const drawPad = (pad, color, glow) => {
      ctx.shadowColor = glow;
      ctx.shadowBlur = 16;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, pad.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath();
      ctx.arc(pad.x - 4, pad.y - 4, pad.r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    };
    drawPad(g.paddles.left, "#3d8bfd", "#3d8bfd");
    drawPad(g.paddles.right, "#ff5a3d", "#ff5a3d");

    // Puck
    const b = g.ball;
    if (g.serveT > 0) {
      ctx.fillStyle = "rgba(255,209,102,0.7)";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Get ready…", w / 2, h / 2 - 40);
      ctx.textAlign = "left";
    }
    ctx.fillStyle = "#f4f7ff";
    ctx.shadowColor = "#ffd166";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Hint
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("drag paddle on your half", w / 2, h - 14);
    ctx.textAlign = "left";
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
        : "Left takes the round.";
      sfx("win");
    } else if (w === "right") {
      resultTitle.textContent = "RIGHT WINS";
      resultSub.textContent = state.swapped
        ? "Logical Right scored — check who held that side!"
        : "Right takes the round.";
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
    } else if (state.modeId === "puck") {
      const s = state.game.scores;
      if (s.left > s.right) endRound("left");
      else if (s.right > s.left) endRound("right");
      else {
        state.winner = "draw";
        state.running = false;
        setTimeout(showResult, 400);
      }
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
      if (state.modeId === "puck") updatePuck(dt);
      if (state.modeId === "hungry") updateHungry(dt);
      updateParticles(dt);
    }

    if (state.modeId === "balloon") drawBalloon();
    if (state.modeId === "puck") drawPuck();
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
