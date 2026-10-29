// Daily challenge: 5 questions per UTC day, one answer each, 25 seconds per question.
// Answers are scored by tier. Nothing about the answer list is ever sent to the browser.
const fs = require("fs");
const path = require("path");

const TIERS = [
  { key: "refill", name: "Refill", points: 15 },
  { key: "spinner", name: "Spinner", points: 30 },
  { key: "pufferfish", name: "Pufferfish", points: 60 },
  { key: "seeker", name: "Seeker", points: 85 },
  { key: "celestillion", name: "Celestillion", points: 100 },
];
const TIER_BY_KEY = Object.fromEntries(TIERS.map(t => [t.key, t]));
const PER_DAY = 5;
const ANSWER_MS = (Number(process.env.DAILY_SECONDS) || 25) * 1000;
const GRACE_MS = 1500; // allowance for network delay on the last second
const DAY_MS = 86_400_000;
// Day #1 of the daily challenge.
const EPOCH_DAY = Math.floor(Date.UTC(2026, 9, 29) / DAY_MS);

const STOP = new Set(["a", "an", "the"]);
// Lowercases, strips accents and punctuation, and drops "a", "an", "the".
// Keeps + and # so "c", "c++" and "c#" stay different answers.
function norm(s) {
  return String(s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’`]/g, "'")
    .replace(/'/g, "")
    .replace(/[^a-z0-9+# ]+/g, " ")
    .split(/\s+/)
    .filter(w => w && !STOP.has(w))
    .join(" ");
}
// Same as norm, but without spaces, so "spider man" matches "spiderman".
const squash = s => norm(s).replace(/ /g, "");

// Edit distance where swapping two neighbouring letters counts as one typo.
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}
// How many typos an answer of this length tolerates.
const tolerance = len => (len >= 12 ? 2 : len >= 6 ? 1 : 0);

function loadQuestions(file = path.join(__dirname, "daily.txt")) {
  const questions = [];
  let q = null;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("?")) {
      q = { text: line.slice(1).trim(), answers: [] };
      questions.push(q);
      return;
    }
    const m = line.match(/^([a-z]+)\s*:\s*(.*)$/i);
    if (!m || !q) throw new Error(`daily.txt line ${i + 1}: expected "? question" or "tier: answers"`);
    const tier = TIER_BY_KEY[m[1].toLowerCase()];
    if (!tier) throw new Error(`daily.txt line ${i + 1}: unknown tier "${m[1]}"`);
    for (const item of m[2].split(",")) {
      const alts = item.split("|").map(s => s.trim()).filter(Boolean);
      if (alts.length) q.answers.push({ display: alts[0], tier: tier.key, keys: [...new Set(alts.map(squash))] });
    }
  });
  if (!questions.length) throw new Error("daily.txt has no questions");
  return questions;
}

/** Finds the answer a guess refers to: exact first, then the closest one within typo tolerance. */
function matchAnswer(question, text) {
  const t = squash(text);
  if (!t) return null;
  for (const a of question.answers) if (a.keys.includes(t)) return a;
  let best = null, bestD = Infinity;
  for (const a of question.answers) {
    for (const k of a.keys) {
      const tol = tolerance(k.length);
      if (!tol) continue;
      const d = lev(t, k, tol);
      if (d <= tol && d < bestD) { best = a; bestD = d; }
    }
  }
  return best;
}

const dayIndex = (now = Date.now()) => Math.floor(now / DAY_MS);
const dayNumber = (now = Date.now()) => dayIndex(now) - EPOCH_DAY + 1;
const resetsAt = (now = Date.now()) => (dayIndex(now) + 1) * DAY_MS;
/** The questions for a given day, rotating through the file. */
function questionsFor(questions, now = Date.now()) {
  const start = (((dayNumber(now) - 1) * PER_DAY) % questions.length + questions.length) % questions.length;
  return Array.from({ length: PER_DAY }, (_, k) => questions[(start + k) % questions.length]);
}

/* ---------------- Saved state: today's runs and leaderboards ---------------- */
function createStore(dir = process.env.DATA_DIR || path.join(__dirname, "data")) {
  const file = path.join(dir, "daily.json");
  let data = { runs: {}, boards: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  data.runs ||= {}; data.boards ||= {};
  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file + ".tmp", JSON.stringify(data));
        fs.renameSync(file + ".tmp", file);
      } catch (e) { console.error("Could not save daily data:", e.message); }
    }, 300);
  }
  function prune(today) {
    for (const k of Object.keys(data.runs)) if (Number(k) < today) delete data.runs[k];
    for (const k of Object.keys(data.boards)) if (Number(k) < today - 7) delete data.boards[k];
  }
  function flush() {
    clearTimeout(timer);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch {}
  }
  return { data, save, prune, flush };
}

function createDaily({ questions = loadQuestions(), store = createStore(), now = () => Date.now(), onFinish = null } = {}) {
  function runFor(pid) {
    const day = dayNumber(now());
    store.prune(day);
    const runs = (store.data.runs[day] ||= {});
    return (runs[pid] ||= { results: [], current: null, finishedAt: null, name: "" });
  }

  // A question left unanswered past its deadline scores 0.
  function expire(run, t) {
    if (run.current && t > run.current.deadline + GRACE_MS) {
      run.results.push({ text: "", points: 0, tier: null, timedOut: true });
      run.current = null;
      finishIfDone(run, t);
      store.save();
    }
  }

  function finishIfDone(run, t) {
    if (run.results.length >= PER_DAY && !run.finishedAt) {
      run.finishedAt = t;
      const day = dayNumber(t);
      const board = (store.data.boards[day] ||= {});
      const total = run.results.reduce((s, r) => s + r.points, 0);
      board[run.pid] = { name: run.name || "Player", score: total, at: t, tiers: run.results.map(r => r.tier) };
      onFinish?.(run.pid, day, total);
    }
  }

  /** Today's scores, best first. Pass `only` (a set of player ids) for a friends-only board. */
  function leaderboard(day = dayNumber(now()), limit = 20, only = null) {
    const board = store.data.boards[day] || {};
    return Object.entries(board)
      .filter(([pid]) => !only || only.has(pid))
      .map(([pid, e]) => ({ pid, ...e }))
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .slice(0, limit)
      .map((e, i) => ({ rank: i + 1, id: e.pid, name: e.name, score: e.score }));
  }

  function publicState(pid, run, t, friends = null) {
    const today = questionsFor(questions, t);
    const done = run.results.length >= PER_DAY;
    const state = {
      day: dayNumber(t),
      resetsAt: resetsAt(t),
      serverNow: t,
      perDay: PER_DAY,
      answerMs: ANSWER_MS,
      tiers: TIERS,
      results: run.results.map((r, i) => ({ ...r, question: today[i].text })),
      done,
      total: run.results.reduce((s, r) => s + r.points, 0),
      leaderboard: leaderboard(dayNumber(t)),
      you: pid,
    };
    if (friends) state.friendsBoard = leaderboard(dayNumber(t), 50, new Set([...friends, pid]));
    if (run.current) {
      state.current = { index: run.current.index, question: today[run.current.index].text, deadline: run.current.deadline };
    }
    if (done) {
      const all = leaderboard(dayNumber(t), Infinity);
      state.rank = (all.find(e => e.id === pid)?.rank) ?? null;
      state.players = all.length;
    }
    return state;
  }

  return {
    status(pid, friends = null) {
      const t = now(), run = runFor(pid);
      run.pid = pid;
      expire(run, t);
      return publicState(pid, run, t, friends);
    },
    /** Shows the next question and starts its clock. Calling again before answering returns the same question. */
    next(pid, name, friends = null) {
      const t = now(), run = runFor(pid);
      run.pid = pid;
      if (name) run.name = name;
      expire(run, t);
      if (!run.current && run.results.length < PER_DAY) {
        run.current = { index: run.results.length, deadline: t + ANSWER_MS };
        store.save();
      }
      return publicState(pid, run, t, friends);
    },
    answer(pid, text, name, friends = null) {
      const t = now(), run = runFor(pid);
      run.pid = pid;
      if (name) run.name = name;
      expire(run, t);
      if (!run.current) {
        const s = publicState(pid, run, t, friends);
        const last = run.results[run.results.length - 1];
        return { ...s, last, error: last?.timedOut ? "Time ran out on that question, so it scored 0." : "There's no question waiting for an answer." };
      }
      const today = questionsFor(questions, t);
      const q = today[run.current.index];
      text = String(text ?? "").trim().slice(0, 80);
      const hit = text ? matchAnswer(q, text) : null;
      const result = hit
        ? { text, answer: hit.display, points: TIER_BY_KEY[hit.tier].points, tier: hit.tier }
        : { text, points: 0, tier: null, timedOut: !text };
      run.results.push(result);
      run.current = null;
      finishIfDone(run, t);
      store.save();
      return { ...publicState(pid, run, t, friends), last: result };
    },
    /** When a guest logs in, today's guest run moves to their account (unless the account already played). */
    adopt(fromPid, toPid) {
      const day = dayNumber(now());
      const runs = store.data.runs[day];
      if (!runs || !runs[fromPid] || fromPid === toPid) return;
      const mine = runs[toPid];
      if (!mine || (!mine.results.length && !mine.current)) {
        runs[toPid] = { ...runs[fromPid], pid: toPid };
        delete runs[fromPid];
        const board = store.data.boards[day];
        if (board?.[fromPid]) { board[toPid] = board[fromPid]; delete board[fromPid]; onFinish?.(toPid, day, board[toPid].score); }
        store.save();
      }
    },
    /** Updates the name shown on today's leaderboard after a display name change. */
    rename(pid, name) {
      const day = dayNumber(now());
      const run = store.data.runs[day]?.[pid];
      if (run) run.name = name;
      const entry = store.data.boards[day]?.[pid];
      if (entry) entry.name = name;
      store.save();
    },
    leaderboard,
    flush: () => store.flush(),
  };
}

module.exports = { TIERS, PER_DAY, ANSWER_MS, EPOCH_DAY, DAY_MS, norm, squash, lev, tolerance, loadQuestions, matchAnswer, questionsFor, dayNumber, resetsAt, createStore, createDaily };
