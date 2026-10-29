// Multiplayer rules for Celestillion. Pure functions: no networking here.
//
// Each round is one question. Players take turns giving an answer nobody has said yet this round.
// Wrong or repeated answers don't count; the player keeps trying until their 20 seconds run out.
// Running out of time costs a heart and sits that player out for the rest of the round.
// Once two players have lost a heart in a round, play continues until the turn reaches the
// player who started the round; then a new question begins and everyone with hearts is back in.
// The last player with hearts left wins.
const { matchAnswer } = require("./daily");

const TURN_MS = (Number(process.env.TURN_SECONDS) || 20) * 1000;
const ROUND_PAUSE_MS = (Number(process.env.ROUND_PAUSE_SECONDS) || 6) * 1000;
const START_HEARTS = 3;
const MAX_PLAYERS = 6;
const LOSSES_TO_END_ROUND = 2;

const alive = g => g.order.filter(id => g.hearts[id] > 0);
const inRound = (g, id) => g.hearts[id] > 0 && !g.round.out.includes(id);

function newGame(order, firstQuestion, now = Date.now()) {
  const hearts = {};
  for (const id of order) hearts[id] = START_HEARTS;
  const g = { status: "playing", order, hearts, roundNo: 0, starterSeat: -1, turn: 0, turnNo: 0,
              turnEndsAt: 0, phase: "turn", round: null, lastRound: null, log: [], winner: null, nextRoundAt: 0 };
  startRound(g, firstQuestion, now);
  return g;
}

/** Begins a round with a new question. The starting seat rotates to the next player who still has hearts. */
function startRound(g, question, now = Date.now()) {
  const n = g.order.length;
  let seat = g.starterSeat;
  for (let k = 1; k <= n; k++) {
    const s = (g.starterSeat + k + n) % n;
    if (g.hearts[g.order[s]] > 0) { seat = s; break; }
  }
  g.starterSeat = seat;
  g.roundNo++;
  g.round = { question, starter: g.order[seat], said: [], out: [], losses: 0 };
  g.phase = "turn";
  g.turn = seat;
  g.turnNo++;
  g.turnEndsAt = now + TURN_MS;
}

function endRound(g, now) {
  const q = g.round.question;
  const said = new Set(g.round.said.map(s => s.answer));
  const order = ["celestillion", "seeker", "pufferfish", "spinner", "refill"];
  // A few answers nobody gave, rarest first, to show between rounds.
  const missed = order.flatMap(t => q.answers.filter(a => a.tier === t && !said.has(a.display))).slice(0, 8)
    .map(a => ({ text: a.display, tier: a.tier }));
  g.lastRound = { roundNo: g.roundNo, question: q.text, said: g.round.said.map(s => ({ text: s.answer, pid: s.pid })), missed, total: q.answers.length };
  g.phase = "between";
  g.nextRoundAt = now + ROUND_PAUSE_MS;
}

/** Moves the turn on. Returns "round" if the round ended, otherwise "turn". */
function advance(g, now) {
  const n = g.order.length;
  if (g.round.said.length >= g.round.question.answers.length) { endRound(g, now); return "round"; }
  for (let k = 1; k <= n; k++) {
    const seat = (g.turn + k) % n;
    if (g.round.losses >= LOSSES_TO_END_ROUND && seat === g.starterSeat) { endRound(g, now); return "round"; }
    if (inRound(g, g.order[seat])) {
      g.turn = seat;
      g.turnNo++;
      g.turnEndsAt = now + TURN_MS;
      return "turn";
    }
  }
  // Nobody left in the round.
  endRound(g, now);
  return "round";
}

function checkGameOver(g) {
  const live = alive(g);
  if (g.order.length > 1 ? live.length <= 1 : live.length === 0) {
    g.status = "over";
    g.phase = "over";
    g.winner = live[0] ?? null;
    if (g.round) endRound(g, Date.now());
    g.phase = "over";
    return true;
  }
  return false;
}

/** The current player's answer. Wrong or repeated answers don't change anything; they keep their turn. */
function guess(g, text, now = Date.now()) {
  if (g.status !== "playing" || g.phase !== "turn") return { ok: false, why: "not now" };
  const pid = g.order[g.turn];
  text = String(text ?? "").trim().slice(0, 80);
  if (!text) return { ok: false, why: "empty" };
  const hit = matchAnswer(g.round.question, text);
  if (!hit) return { ok: false, why: "not on the list", text };
  const prior = g.round.said.find(s => s.answer === hit.display);
  if (prior) return { ok: false, why: "already said", text, answer: hit.display, by: prior.pid };
  g.round.said.push({ answer: hit.display, tier: hit.tier, pid, text });
  g.log = [{ pid, text: hit.display, ok: true, round: g.roundNo }, ...g.log].slice(0, 30);
  advance(g, now);
  return { ok: true, answer: hit.display, text };
}

/** The current player ran out of time: lose a heart and sit out the rest of the round. */
function timeout(g, now = Date.now()) {
  if (g.status !== "playing" || g.phase !== "turn") return;
  const pid = g.order[g.turn];
  g.hearts[pid] = Math.max(0, g.hearts[pid] - 1);
  g.round.out.push(pid);
  g.round.losses++;
  g.log = [{ pid, text: g.hearts[pid] ? "ran out of time and lost a heart" : "ran out of time and is out of the game", ok: false, round: g.roundNo }, ...g.log].slice(0, 30);
  if (checkGameOver(g)) return;
  advance(g, now);
}

/** A player who left mid-game loses all their hearts. */
function knockOut(g, pid, now = Date.now()) {
  if (g.status !== "playing" || !g.order.includes(pid) || g.hearts[pid] <= 0) return;
  const wasTurn = g.phase === "turn" && g.order[g.turn] === pid;
  g.hearts[pid] = 0;
  if (!g.round.out.includes(pid)) g.round.out.push(pid);
  g.log = [{ pid, text: "left the game", ok: false, round: g.roundNo }, ...g.log].slice(0, 30);
  if (checkGameOver(g)) return;
  if (wasTurn) advance(g, now);
}

module.exports = { TURN_MS, ROUND_PAUSE_MS, START_HEARTS, MAX_PLAYERS, LOSSES_TO_END_ROUND, newGame, startRound, guess, timeout, knockOut, alive, inRound };
