// Celestillion sound effects. Every sound is synthesized with the Web Audio API,
// so there are no audio files to download or license.
// Browsers only allow sound after the player has clicked or typed, so the audio
// starts on the first interaction. The mute setting is remembered per browser.
(() => {
  let ctx = null, master = null;
  let muted = false;
  try { muted = localStorage.getItem("cel-muted") === "1"; } catch {}

  function ensure() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    // A gentle compressor keeps stacked sounds from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    return ctx;
  }
  const unlock = () => ensure();
  ["pointerdown", "keydown", "touchstart"].forEach(ev => window.addEventListener(ev, unlock, { passive: true }));

  /** One note with a soft attack and an exponential fade, optionally sliding in pitch. */
  function tone(freq, { at = 0, dur = 0.14, type = "sine", gain = 0.3, slide = null, attack = 0.006 } = {}) {
    if (muted || !ensure() || ctx.state !== "running") return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  /** A short burst of filtered noise, for soft "thud" and "whoosh" textures. */
  function noise({ at = 0, dur = 0.12, gain = 0.18, freq = 900, q = 0.8 } = {}) {
    if (muted || !ensure() || ctx.state !== "running") return;
    const t0 = ctx.currentTime + at;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
    g.gain.value = gain;
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  }
  const notes = (list, opts = {}) => list.forEach(([f, at, extra]) => tone(f, { ...opts, ...extra, at }));

  const SOUNDS = {
    // Multiplayer
    correct: () => notes([[784, 0], [1175, 0.07]], { type: "triangle", gain: 0.32, dur: 0.16 }),
    otherCorrect: () => tone(660, { type: "triangle", gain: 0.14, dur: 0.1 }),
    wrong: () => { tone(180, { type: "square", gain: 0.09, dur: 0.16, slide: 120 }); noise({ dur: 0.08, gain: 0.08, freq: 300 }); },
    heartLost: () => { notes([[523, 0], [392, 0.11], [262, 0.22]], { type: "triangle", gain: 0.26, dur: 0.22 }); noise({ at: 0.22, dur: 0.18, gain: 0.12, freq: 220 }); },
    otherHeartLost: () => tone(330, { type: "triangle", gain: 0.13, dur: 0.22, slide: 220 }),
    yourTurn: () => { tone(988, { gain: 0.26, dur: 0.5 }); tone(1480, { at: 0.09, gain: 0.18, dur: 0.6 }); },
    lastSeconds: () => tone(1600, { type: "square", gain: 0.05, dur: 0.035 }),
    roundEnd: () => notes([[523, 0], [659, 0.08], [784, 0.16]], { type: "sine", gain: 0.18, dur: 0.3 }),
    newRound: () => { noise({ dur: 0.25, gain: 0.07, freq: 2200, q: 0.5 }); tone(740, { at: 0.1, gain: 0.18, dur: 0.25 }); },
    win: () => notes([[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3], [1319, 0.42]], { type: "triangle", gain: 0.28, dur: 0.4 }),
    lose: () => notes([[392, 0], [349, 0.16], [311, 0.32], [262, 0.5]], { type: "triangle", gain: 0.22, dur: 0.38 }),
    // Daily challenge
    submit: () => tone(520, { type: "triangle", gain: 0.15, dur: 0.07, slide: 700 }),
    /** One tick of the points count-up; `p` goes from 0 to 1 as the count rises. */
    countTick: p => tone(500 + p * 900, { type: "square", gain: 0.045 + p * 0.03, dur: 0.03 }),
    miss: () => { tone(200, { type: "sine", gain: 0.25, dur: 0.25, slide: 110 }); noise({ dur: 0.12, gain: 0.08, freq: 250 }); },
    tier_refill: () => notes([[660, 0], [880, 0.08]], { type: "triangle", gain: 0.26, dur: 0.22 }),
    tier_spinner: () => notes([[660, 0], [880, 0.08], [1047, 0.16]], { type: "triangle", gain: 0.26, dur: 0.24 }),
    tier_pufferfish: () => notes([[587, 0], [784, 0.08], [988, 0.16], [1175, 0.24]], { type: "triangle", gain: 0.27, dur: 0.28 }),
    tier_seeker: () => { notes([[523, 0], [784, 0.08], [1047, 0.16], [1319, 0.24]], { type: "triangle", gain: 0.27, dur: 0.32 }); tone(2093, { at: 0.34, gain: 0.1, dur: 0.5 }); },
    tier_celestillion: () => {
      notes([[523, 0], [659, 0.07], [784, 0.14], [1047, 0.21], [1319, 0.28], [1568, 0.35]], { type: "triangle", gain: 0.26, dur: 0.45 });
      [2093, 2637, 3136, 2637, 3520].forEach((f, i) => tone(f, { at: 0.45 + i * 0.06, gain: 0.08, dur: 0.35 }));
    },
  };

  window.Sfx = {
    play(name, arg) { try { SOUNDS[name]?.(arg); } catch {} },
    get muted() { return muted; },
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem("cel-muted", muted ? "1" : "0"); } catch {}
      if (!muted) { ensure(); setTimeout(() => SOUNDS.otherCorrect(), 30); }
    },
  };
})();
