// Celestillion server: serves the page, runs every multiplayer room, and the daily challenge.
// The server is authoritative: it holds the answers, checks every guess, and runs the turn clock.
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const G = require("./game");
const { createDaily, loadQuestions, questionsFor } = require("./daily");

const PORT = process.env.PORT || 3000;
const QUESTIONS = loadQuestions();
const LOBBY_DROP_MS = 30_000;     // remove a disconnected player from a lobby after this
const GAME_DROP_MS = 45_000;      // knock a disconnected player out of a running game after this
const ROOM_IDLE_MS = 10 * 60_000; // delete a room nobody is connected to after this

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "4kb" }));
app.get("/healthz", (_req, res) => res.send("ok"));
const server = http.createServer(app);
const io = new Server(server);

/** code -> { code, host, players: Map<pid, {name, joinedAt, sockets, dropTimer}>, game, turnTimer, idleTimer } */
const rooms = new Map();

const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
function newCode() {
  for (;;) {
    const c = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join("");
    if (!rooms.has(c)) return c;
  }
}
// Each browser keeps a secret token; everyone else only ever sees this derived public id.
const publicId = token => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 10);
const cleanName = n => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 18);

/* ---------------- Daily challenge (single player) ---------------- */
const daily = createDaily();
function dailyPlayer(req, res) {
  const token = req.body?.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 100) {
    res.status(400).json({ ok: false, error: "Bad player token. Refresh the page and try again." });
    return null;
  }
  return publicId(token);
}
app.post("/api/daily/status", (req, res) => {
  const pid = dailyPlayer(req, res); if (!pid) return;
  res.json({ ok: true, state: daily.status(pid) });
});
app.post("/api/daily/next", (req, res) => {
  const pid = dailyPlayer(req, res); if (!pid) return;
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: "Enter your name first." });
  res.json({ ok: true, state: daily.next(pid, name) });
});
app.post("/api/daily/answer", (req, res) => {
  const pid = dailyPlayer(req, res); if (!pid) return;
  const state = daily.answer(pid, req.body.text, cleanName(req.body.name));
  res.json({ ok: !state.error, error: state.error, state });
});

/** Picks the room's next question: a shuffled pass through the list, skipping today's daily questions. */
function nextQuestion(room) {
  if (!room.queue?.length) {
    const daily = new Set(questionsFor(QUESTIONS).map(q => q.text));
    const pool = QUESTIONS.filter(q => !daily.has(q.text) && !room.asked?.has(q.text));
    const list = pool.length ? pool : QUESTIONS.filter(q => !daily.has(q.text));
    if (!pool.length) room.asked = new Set();
    for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    room.queue = list;
  }
  const q = room.queue.pop();
  (room.asked ||= new Set()).add(q.text);
  return q;
}

function view(room) {
  const g = room.game;
  const players = [...room.players.entries()]
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .map(([id, p]) => ({ id, name: p.name, connected: p.sockets > 0 }));
  const base = { code: room.code, host: room.host, players, turnMs: G.TURN_MS, hearts: G.START_HEARTS, serverNow: Date.now() };
  if (!g) return { ...base, status: "lobby" };
  const r = g.round;
  return {
    ...base,
    status: g.status,
    game: {
      order: g.order, hearts: g.hearts, phase: g.phase, turn: g.turn, turnNo: g.turnNo, turnEndsAt: g.turnEndsAt,
      roundNo: g.roundNo, nextRoundAt: g.nextRoundAt, winner: g.winner, log: g.log,
      // Only the question and the answers already given this round are sent; the answer list stays on the server.
      round: r && { question: r.question.text, starter: r.starter, out: r.out, losses: r.losses,
                    said: r.said.map(s => ({ text: s.answer, pid: s.pid })) },
      lastRound: g.lastRound,
    },
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", view(room));
}

// One timer per room: either the current turn's 20 seconds, or the pause between rounds.
function scheduleTurn(room) {
  clearTimeout(room.turnTimer);
  const g = room.game;
  if (!g || g.status !== "playing") return;
  if (g.phase === "between") {
    const roundNo = g.roundNo;
    room.turnTimer = setTimeout(() => {
      if (room.game === g && g.status === "playing" && g.phase === "between" && g.roundNo === roundNo) {
        G.startRound(g, nextQuestion(room));
        afterChange(room);
      }
    }, Math.max(0, g.nextRoundAt - Date.now()));
    return;
  }
  const turnNo = g.turnNo;
  room.turnTimer = setTimeout(() => {
    if (room.game === g && g.status === "playing" && g.phase === "turn" && g.turnNo === turnNo) {
      G.timeout(g);
      afterChange(room);
    }
  }, Math.max(0, g.turnEndsAt - Date.now()) + 300);
}

function afterChange(room) {
  scheduleTurn(room);
  broadcast(room);
}

function touchIdle(room) {
  clearTimeout(room.idleTimer);
  const anyone = [...room.players.values()].some(p => p.sockets > 0);
  if (!anyone) {
    room.idleTimer = setTimeout(() => {
      clearTimeout(room.turnTimer);
      rooms.delete(room.code);
    }, ROOM_IDLE_MS);
  }
}

function pickNewHost(room) {
  if (room.players.has(room.host) && room.players.get(room.host).sockets > 0) return;
  const next = [...room.players.entries()]
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .find(([, p]) => p.sockets > 0);
  if (next) room.host = next[0];
}

function removePlayer(room, pid) {
  const p = room.players.get(pid);
  if (!p) return;
  clearTimeout(p.dropTimer);
  if (room.game) G.knockOut(room.game, pid);
  // Keep players who are part of a game's record so names still show on the board.
  if (!room.game || !room.game.order.includes(pid)) room.players.delete(pid);
  else p.sockets = 0;
  pickNewHost(room);
  touchIdle(room);
  afterChange(room);
}

function leaveCurrent(socket) {
  const { code, pid } = socket.data;
  const room = code && rooms.get(code);
  socket.data.code = null;
  if (!room) return;
  socket.leave(code);
  const p = room.players.get(pid);
  if (!p) return;
  p.sockets = Math.max(0, p.sockets - 1);
  return { room, p, pid };
}

io.on("connection", socket => {
  socket.data = { pid: null, code: null };

  socket.on("hello", ({ token } = {}, ack) => {
    if (typeof token !== "string" || token.length < 16 || token.length > 100) return ack?.({ ok: false, error: "Bad player token." });
    socket.data.pid = publicId(token);
    ack?.({ ok: true, you: socket.data.pid });
  });

  function enter(room, name) {
    const pid = socket.data.pid;
    let p = room.players.get(pid);
    if (!p) {
      p = { name, joinedAt: Date.now(), sockets: 0, dropTimer: null };
      room.players.set(pid, p);
    } else if (name) {
      p.name = name;
    }
    clearTimeout(p.dropTimer);
    if (socket.data.code === room.code) { broadcast(room); return; } // this tab is already in the room
    p.sockets++;
    socket.join(room.code);
    socket.data.code = room.code;
    pickNewHost(room);
    touchIdle(room);
    broadcast(room);
  }

  socket.on("create", ({ name } = {}, ack) => {
    name = cleanName(name);
    if (!socket.data.pid) return ack?.({ ok: false, error: "Not connected yet. Try again in a moment." });
    if (!name) return ack?.({ ok: false, error: "Enter your name first." });
    leaveCurrent(socket);
    const room = { code: newCode(), host: socket.data.pid, players: new Map(), game: null, turnTimer: null, idleTimer: null };
    rooms.set(room.code, room);
    enter(room, name);
    ack?.({ ok: true, code: room.code, state: view(room) });
  });

  socket.on("join", ({ code, name } = {}, ack) => {
    name = cleanName(name);
    code = String(code ?? "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!socket.data.pid) return ack?.({ ok: false, error: "Not connected yet. Try again in a moment." });
    if (!name) return ack?.({ ok: false, error: "Enter your name first." });
    if (!room) return ack?.({ ok: false, error: `No room with code ${code}. Check the letters and try again.` });
    const already = room.players.has(socket.data.pid);
    if (!already && room.players.size >= G.MAX_PLAYERS) return ack?.({ ok: false, error: `That room is full (${G.MAX_PLAYERS} players).` });
    if (socket.data.code !== code) leaveCurrent(socket);
    enter(room, name);
    ack?.({ ok: true, code, state: view(room) });
  });

  socket.on("start", (_ = {}, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.data.pid) return ack?.({ ok: false, error: "Only the host can start the game." });
    if (room.game && room.game.status === "playing") return ack?.({ ok: false, error: "A game is already running." });
    const order = [...room.players.entries()]
      .filter(([, p]) => p.sockets > 0)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .map(([id]) => id);
    // Drop anyone left over from the last game who is no longer here.
    for (const id of [...room.players.keys()]) if (!order.includes(id)) room.players.delete(id);
    room.game = G.newGame(order, nextQuestion(room));
    afterChange(room);
    ack?.({ ok: true });
  });

  socket.on("guess", ({ text } = {}, ack) => {
    const room = rooms.get(socket.data.code);
    const g = room?.game;
    if (!g || g.status !== "playing") return ack?.({ ok: false, error: "No game is running." });
    if (g.phase !== "turn") return ack?.({ ok: false, error: "The next question is about to start." });
    if (g.order[g.turn] !== socket.data.pid) return ack?.({ ok: false, error: "It's not your turn." });
    text = String(text ?? "").trim();
    if (!text) return ack?.({ ok: false, error: "Type an answer first." });
    const result = G.guess(g, text);
    // A wrong or repeated answer only goes back to the player who typed it; their clock keeps running.
    if (result.ok) afterChange(room);
    ack?.({ ok: true, result });
  });

  socket.on("lobby", (_ = {}, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.data.pid) return ack?.({ ok: false, error: "Only the host can do that." });
    if (room.game?.status === "playing") return ack?.({ ok: false, error: "Finish the current game first." });
    clearTimeout(room.turnTimer);
    room.game = null;
    for (const [id, p] of [...room.players]) if (p.sockets === 0) room.players.delete(id);
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on("leave", (_ = {}, ack) => {
    const left = leaveCurrent(socket);
    if (left && left.p.sockets === 0) removePlayer(left.room, left.pid);
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const left = leaveCurrent(socket);
    if (!left) return;
    const { room, p, pid } = left;
    if (p.sockets > 0) return; // still open in another tab
    pickNewHost(room);
    touchIdle(room);
    broadcast(room);
    const wait = room.game?.status === "playing" ? GAME_DROP_MS : LOBBY_DROP_MS;
    p.dropTimer = setTimeout(() => {
      if (p.sockets === 0 && rooms.get(room.code) === room) removePlayer(room, pid);
    }, wait);
  });
});

// Save daily results before Render (or anything else) stops the server.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { daily.flush(); process.exit(0); });

server.listen(PORT, () => console.log(`Celestillion running on http://localhost:${PORT} with ${QUESTIONS.length} questions`));
module.exports = { server, rooms, daily };
