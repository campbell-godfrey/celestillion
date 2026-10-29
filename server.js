// Celestillion server: serves the page, runs every multiplayer room, and the daily challenge.
// The server is authoritative: it holds the answers, checks every guess, and runs the turn clock.
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const G = require("./game");
const { createDaily, loadQuestions, questionsFor } = require("./daily");
const { createAccounts, parseCookies, rateLimiter, SESSION_MS } = require("./accounts");

const PORT = process.env.PORT || 3000;
const QUESTIONS = loadQuestions();
const LOBBY_DROP_MS = 30_000;     // remove a disconnected player from a lobby after this
const GAME_DROP_MS = 45_000;      // knock a disconnected player out of a running game after this
const ROOM_IDLE_MS = 10 * 60_000; // delete a room nobody is connected to after this

const app = express();
app.set("trust proxy", 1); // Render puts the app behind a proxy; this makes req.secure and req.ip correct
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

/* ---------------- Optional accounts ---------------- */
const accounts = createAccounts();
const SESSION_COOKIE = "cel_session";
const userPid = u => "u_" + u.id;

function sessionToken(req) { return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null; }
function currentUser(req) { return accounts.userForSession(sessionToken(req)); }
function setSessionCookie(req, res, token) {
  const secure = req.secure ? "; Secure" : "";
  const age = token ? Math.floor(SESSION_MS / 1000) : 0;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token || ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`);
}
function guestPid(token) {
  return typeof token === "string" && token.length >= 16 && token.length <= 100 ? publicId(token) : null;
}
// Logged-in players are known by their account; guests by the random token their browser keeps.
function playerFor(req) {
  const user = currentUser(req);
  if (user) return { pid: userPid(user), user };
  const pid = guestPid(req.body?.token);
  return pid ? { pid, user: null } : null;
}
const friendPids = user => (user ? accounts.friendIds(user.id).map(id => "u_" + id) : null);
function signIn(req, res, user, guestToken) {
  setSessionCookie(req, res, accounts.createSession(user.id));
  const g = guestPid(guestToken);
  if (g) { daily.adopt(g, userPid(user)); daily.rename(userPid(user), user.displayName); } // keep today's guest run, under the account's name
}
/** Renames this player everywhere their name is currently shown. */
function renameEverywhere(user) {
  const pid = userPid(user);
  daily.rename(pid, user.displayName);
  for (const room of rooms.values()) {
    const p = room.players.get(pid);
    if (p) { p.name = user.displayName; broadcast(room); }
  }
}

// Refuse cross-site form posts: every state-changing request must come from this site, as JSON.
app.use("/api", (req, res, next) => {
  if (req.method !== "POST") return next();
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false, error: "Requests must come from this site." }); }
    catch { return res.status(403).json({ ok: false, error: "Requests must come from this site." }); }
  }
  if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "Send JSON." });
  next();
});
const loginLimit = rateLimiter(10, 15 * 60_000);
const ipLimit = rateLimiter(60, 15 * 60_000);
const registerLimit = rateLimiter(10, 60 * 60_000);
const fail = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message || String(e) });
const needUser = (req, res) => { const u = currentUser(req); if (!u) fail(res, new Error("Log in first."), 401); return u; };
const me = u => ({ ok: true, user: accounts.publicUser(u) });

app.get("/api/me", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, user: accounts.publicUser(currentUser(req)), discord: discordEnabled() });
});
app.post("/api/auth/register", (req, res) => {
  if (!registerLimit(req.ip)) return fail(res, new Error("Too many new accounts from here. Try again later."), 429);
  try {
    const u = accounts.register(req.body.username, req.body.password);
    signIn(req, res, u, req.body.token);
    res.json(me(u));
  } catch (e) { fail(res, e); }
});
app.post("/api/auth/login", (req, res) => {
  const key = req.ip + "|" + String(req.body.username ?? "").toLowerCase();
  if (!ipLimit(req.ip) || !loginLimit(key)) return fail(res, new Error("Too many attempts. Wait a few minutes and try again."), 429);
  try {
    const u = accounts.login(req.body.username, req.body.password);
    signIn(req, res, u, req.body.token);
    res.json(me(u));
  } catch (e) { fail(res, e, 401); }
});
app.post("/api/auth/logout", (req, res) => {
  accounts.endSession(sessionToken(req));
  setSessionCookie(req, res, null);
  res.json({ ok: true });
});
app.post("/api/account/name", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  try { accounts.setDisplayName(u.id, req.body.displayName); renameEverywhere(u); res.json(me(u)); } catch (e) { fail(res, e); }
});
app.post("/api/account/password", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  if (!loginLimit(req.ip + "|pw|" + u.id)) return fail(res, new Error("Too many attempts. Wait a few minutes and try again."), 429);
  try { accounts.setPassword(u.id, req.body.current, req.body.next); res.json(me(u)); } catch (e) { fail(res, e); }
});
app.post("/api/account/discord/unlink", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  try { accounts.unlinkDiscord(u.id); res.json(me(u)); } catch (e) { fail(res, e); }
});
app.post("/api/friends/request", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  try { accounts.requestFriend(u.id, req.body.username); res.json(me(u)); } catch (e) { fail(res, e); }
});
app.post("/api/friends/accept", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  try { accounts.acceptFriend(u.id, String(req.body.id ?? "")); res.json(me(u)); } catch (e) { fail(res, e); }
});
app.post("/api/friends/remove", (req, res) => {
  const u = needUser(req, res); if (!u) return;
  try { accounts.dropFriend(u.id, String(req.body.id ?? "")); res.json(me(u)); } catch (e) { fail(res, e); }
});

/* ---------- Log in with Discord (OAuth2 authorization code flow) ---------- */
const DISCORD = {
  clientId: process.env.DISCORD_CLIENT_ID,
  secret: process.env.DISCORD_CLIENT_SECRET,
  authorizeUrl: process.env.DISCORD_AUTHORIZE_URL || "https://discord.com/oauth2/authorize",
  api: process.env.DISCORD_API_BASE || "https://discord.com/api/v10",
  tokenUrl: process.env.DISCORD_TOKEN_URL || "https://discord.com/api/oauth2/token",
  issuer: process.env.DISCORD_ISSUER || "https://discord.com",
};
function discordEnabled() { return !!(DISCORD.clientId && DISCORD.secret); }
function siteUrl(req) { return (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, ""); }
const redirectUri = req => siteUrl(req) + "/auth/discord/callback";
const STATE_COOKIE = "cel_oauth";

app.get("/auth/discord", (req, res) => {
  if (!discordEnabled()) return res.redirect("/?auth_error=discord_off#login");
  const state = crypto.randomBytes(16).toString("hex");
  const link = req.query.link === "1" && currentUser(req) ? "link" : "login";
  const secure = req.secure ? "; Secure" : "";
  // The state ties Discord's reply to this browser. SameSite=Lax lets it come back on Discord's redirect.
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=${state}.${link}; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
  const q = new URLSearchParams({ response_type: "code", client_id: DISCORD.clientId, scope: "identify",
                                  redirect_uri: redirectUri(req), state, prompt: "none" });
  res.redirect(`${DISCORD.authorizeUrl}?${q}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const [state, mode] = String(cookies[STATE_COOKIE] || "").split(".");
  const secure = req.secure ? "; Secure" : "";
  const clearState = `${STATE_COOKIE}=; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const back = (err, hash = "login") => { res.setHeader("Set-Cookie", clearState); res.redirect(err ? `/?auth_error=${err}#${hash}` : `/#${hash}`); };
  if (req.query.error) return back("discord_cancelled");
  if (!state || req.query.state !== state) return back("discord_state");
  if (req.query.iss && req.query.iss !== DISCORD.issuer) return back("discord_state");
  try {
    const tokenRes = await fetch(DISCORD.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DISCORD.clientId, client_secret: DISCORD.secret, grant_type: "authorization_code",
                                  code: String(req.query.code || ""), redirect_uri: redirectUri(req) }),
    });
    if (!tokenRes.ok) return back("discord_failed");
    const { access_token } = await tokenRes.json();
    const meRes = await fetch(`${DISCORD.api}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!meRes.ok) return back("discord_failed");
    const duser = await meRes.json();
    if (!duser?.id) return back("discord_failed");

    if (mode === "link") {
      const u = currentUser(req);
      if (!u) return back("discord_failed");
      try { accounts.discordLogin(duser, u.id); } catch { return back("discord_taken", "account"); }
      return back(null, "account");
    }
    const u = accounts.discordLogin(duser);
    const token = accounts.createSession(u.id);
    const guest = guestPid(cookies.cel_guest);
    if (guest) { daily.adopt(guest, userPid(u)); daily.rename(userPid(u), u.displayName); }
    res.setHeader("Set-Cookie", [clearState,
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`,
      `cel_guest=; Path=/; Max-Age=0`]);
    res.redirect("/#account");
  } catch (e) {
    console.error("Discord login failed:", e.message);
    back("discord_failed");
  }
});

/* ---------------- Daily challenge (single player) ---------------- */
// Scores are saved to the player's account history when they're logged in.
const daily = createDaily({ onFinish: (pid, day, total) => { if (pid.startsWith("u_")) accounts.recordScore(pid.slice(2), day, total); } });
function dailyPlayer(req, res) {
  const p = playerFor(req);
  if (!p) res.status(400).json({ ok: false, error: "Bad player token. Refresh the page and try again." });
  return p;
}
app.post("/api/daily/status", (req, res) => {
  const p = dailyPlayer(req, res); if (!p) return;
  res.json({ ok: true, state: daily.status(p.pid, friendPids(p.user)) });
});
app.post("/api/daily/next", (req, res) => {
  const p = dailyPlayer(req, res); if (!p) return;
  const name = p.user ? p.user.displayName : cleanName(req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: "Enter your name first." });
  res.json({ ok: true, state: daily.next(p.pid, name, friendPids(p.user)) });
});
app.post("/api/daily/answer", (req, res) => {
  const p = dailyPlayer(req, res); if (!p) return;
  const name = p.user ? p.user.displayName : cleanName(req.body.name);
  const state = daily.answer(p.pid, req.body.text, name, friendPids(p.user));
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
  socket.data = { pid: null, code: null, userId: null };

  // Logged-in players are identified by their session cookie (sent with the connection); guests by their token.
  socket.on("hello", ({ token } = {}, ack) => {
    const user = accounts.userForSession(parseCookies(socket.request.headers.cookie)[SESSION_COOKIE]);
    if (user) {
      socket.data.pid = userPid(user);
      socket.data.userId = user.id;
      return ack?.({ ok: true, you: socket.data.pid, displayName: user.displayName });
    }
    if (typeof token !== "string" || token.length < 16 || token.length > 100) return ack?.({ ok: false, error: "Bad player token." });
    socket.data.pid = publicId(token);
    ack?.({ ok: true, you: socket.data.pid });
  });
  // Account players always appear under their display name.
  const nameFor = typed => (socket.data.userId ? accounts.get(socket.data.userId)?.displayName : null) || cleanName(typed);

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
    name = nameFor(name);
    if (!socket.data.pid) return ack?.({ ok: false, error: "Not connected yet. Try again in a moment." });
    if (!name) return ack?.({ ok: false, error: "Enter your name first." });
    leaveCurrent(socket);
    const room = { code: newCode(), host: socket.data.pid, players: new Map(), game: null, turnTimer: null, idleTimer: null };
    rooms.set(room.code, room);
    enter(room, name);
    ack?.({ ok: true, code: room.code, state: view(room) });
  });

  socket.on("join", ({ code, name } = {}, ack) => {
    name = nameFor(name);
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
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { daily.flush(); accounts.flush(); process.exit(0); });
setInterval(() => accounts.pruneSessions(), 6 * 3600_000).unref();

server.listen(PORT, () => console.log(`Celestillion running on http://localhost:${PORT} with ${QUESTIONS.length} questions`));
module.exports = { server, rooms, daily };
