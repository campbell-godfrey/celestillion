// Checks optional accounts end to end over HTTP: sign-up, login, sessions, display names,
// top 5 scores, friends, guest runs carried into an account, and Discord login against a fake Discord.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-"));
process.env.DATA_DIR = dir;
process.env.PORT = "3988";
process.env.DAILY_SECONDS = "25";

// ---- A fake Discord, so the OAuth flow can be tested without real credentials ----
const FAKE_PORT = 3987;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${FAKE_PORT}`);
  if (url.pathname === "/oauth2/authorize") {
    // Discord would show a consent screen, then send the browser back with a code.
    res.writeHead(302, { Location: `${url.searchParams.get("redirect_uri")}?code=good-code&state=${url.searchParams.get("state")}` });
    return res.end();
  }
  if (url.pathname === "/api/oauth2/token" && req.method === "POST") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const ok = req.headers["content-type"].startsWith("application/x-www-form-urlencoded")
        && p.get("code") === "good-code" && p.get("client_secret") === "shh" && p.get("grant_type") === "authorization_code";
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { access_token: "tok123", token_type: "Bearer" } : { error: "invalid_grant" }));
    });
    return;
  }
  if (url.pathname === "/api/v10/users/@me") {
    const ok = req.headers.authorization === "Bearer tok123";
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(ok ? { id: "80351110224678912", username: "nelly", global_name: "Nelly" } : {}));
  }
  res.writeHead(404); res.end();
}).listen(FAKE_PORT);
process.env.DISCORD_CLIENT_ID = "123";
process.env.DISCORD_CLIENT_SECRET = "shh";
process.env.DISCORD_AUTHORIZE_URL = `http://localhost:${FAKE_PORT}/oauth2/authorize`;
process.env.DISCORD_TOKEN_URL = `http://localhost:${FAKE_PORT}/api/oauth2/token`;
process.env.DISCORD_API_BASE = `http://localhost:${FAKE_PORT}/api/v10`;

const { server, daily } = require("./server");
const BASE = `http://localhost:${process.env.PORT}`;
const D = require("./daily");
const questions = D.loadQuestions();

/** A tiny browser: keeps cookies between requests. */
function browser() {
  const jar = {};
  const store = res => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some(a => /max-age=0/i.test(a)) || v === "") delete jar[k.trim()]; else jar[k.trim()] = v;
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    jar,
    async post(p, body = {}, extra = {}) {
      const res = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie(), ...extra }, body: JSON.stringify(body) });
      store(res);
      return { status: res.status, json: await res.json() };
    },
    async get(p) {
      const res = await fetch(BASE + p, { headers: { Cookie: cookie() }, redirect: "manual" });
      store(res);
      return res;
    },
    async getFrom(url) {
      const res = await fetch(url, { headers: { Cookie: cookie() }, redirect: "manual" });
      store(res);
      return res;
    },
  };
}
const GUEST = "guest-token-abcdefghijklmnop";
const todays = D.questionsFor(questions);
const answerFor = (q, tier) => q.answers.find(a => a.tier === tier).display;
async function playDaily(b, tier = "celestillion", token = GUEST) {
  for (let i = 0; i < 5; i++) {
    await b.post("/api/daily/next", { token, name: "Guest" });
    await b.post("/api/daily/answer", { token, text: answerFor(todays[i], tier), name: "Guest" });
  }
  return (await b.post("/api/daily/status", { token })).json.state;
}

(async () => {
  // ---- Guests still play without logging in ----
  const guest = browser();
  let r = await guest.post("/api/daily/status", { token: GUEST });
  assert.ok(r.json.ok && !r.json.state.friendsBoard, "guests can play");
  assert.strictEqual((await (await guest.get("/api/me")).json()).user, null);

  // ---- Sign up ----
  const alice = browser();
  r = await alice.post("/api/auth/register", { username: "Alice", password: "short" });
  assert.strictEqual(r.status, 400, "short passwords are refused");
  r = await alice.post("/api/auth/register", { username: "a!", password: "longenough" });
  assert.strictEqual(r.status, 400, "bad usernames are refused");
  r = await alice.post("/api/auth/register", { username: "Alice", password: "correct horse" });
  assert.ok(r.json.ok, "sign up");
  assert.strictEqual(r.json.user.username, "alice");
  assert.strictEqual(r.json.user.displayName, "Alice");
  assert.ok(alice.jar.cel_session, "a session cookie is set");
  assert.ok(!JSON.stringify(r.json).includes("scrypt"), "password hashes never leave the server");
  r = await browser().post("/api/auth/register", { username: "ALICE", password: "another one" });
  assert.match(r.json.error, /taken/, "usernames are unique, ignoring capitals");

  // ---- Cross-site requests are refused ----
  r = await alice.post("/api/account/name", { displayName: "Hacked" }, { Origin: "https://evil.example" });
  assert.strictEqual(r.status, 403);

  // ---- Display name ----
  r = await alice.post("/api/account/name", { displayName: "  Ally   Cat " });
  assert.strictEqual(r.json.user.displayName, "Ally Cat");
  r = await alice.post("/api/account/name", { displayName: "   " });
  assert.strictEqual(r.status, 400, "empty display names are refused");

  // ---- Log out, wrong password, log in ----
  await alice.post("/api/auth/logout");
  assert.ok(!alice.jar.cel_session, "logging out clears the cookie");
  r = await alice.post("/api/account/name", { displayName: "x" });
  assert.strictEqual(r.status, 401, "account pages need a login");
  r = await alice.post("/api/auth/login", { username: "alice", password: "wrong password" });
  assert.strictEqual(r.json.error, "Wrong username or password.");
  r = await alice.post("/api/auth/login", { username: "nobody", password: "wrong password" });
  assert.strictEqual(r.json.error, "Wrong username or password.", "same message whether or not the user exists");
  r = await alice.post("/api/auth/login", { username: "ALICE", password: "correct horse" });
  assert.ok(r.json.ok, "log in");

  // ---- Logged-in daily play: name comes from the account, score goes to the top 5 ----
  const st = await playDaily(alice, "seeker", "alice-browser-token-0000");
  assert.strictEqual(st.total, 425);
  assert.strictEqual(st.leaderboard.find(e => e.id === st.you).name, "Ally Cat");
  r = await (await alice.get("/api/me")).json();
  assert.deepStrictEqual(r.user.topScores, [{ day: st.day, score: 425 }]);
  // Logging in from another browser keeps the same account run (no second play today)
  const alice2 = browser();
  await alice2.post("/api/auth/login", { username: "alice", password: "correct horse" });
  r = await alice2.post("/api/daily/next", { token: "other-browser-token-1111" });
  assert.ok(r.json.state.done && !r.json.state.current, "one play per day follows the account");
  // Renaming updates today's leaderboard
  await alice.post("/api/account/name", { displayName: "Alice" });
  r = await alice.post("/api/daily/status", {});
  assert.strictEqual(r.json.state.leaderboard.find(e => e.id === r.json.state.you).name, "Alice");

  // ---- Top 5 keeps the best five days ----
  const dayNow = D.dayNumber();
  const { createAccounts } = require("./accounts");
  const offline = createAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "acct2-")));
  const u = offline.register("topper", "password123");
  [100, 300, 50, 500, 250, 400, 200].forEach((sc, i) => offline.recordScore(u.id, dayNow - i, sc));
  assert.deepStrictEqual(offline.publicUser(u).topScores.map(s => s.score), [500, 400, 300, 250, 200]);
  assert.strictEqual(offline.publicUser(u).gamesPlayed, 7);

  // ---- A guest who plays, then signs up, keeps today's run ----
  const bob = browser();
  const bobState = await playDaily(bob, "refill", "bob-guest-token-22222222");
  assert.strictEqual(bobState.total, 75);
  r = await bob.post("/api/auth/register", { username: "bob", password: "bobs password", token: "bob-guest-token-22222222" });
  r = await (await bob.get("/api/me")).json();
  assert.deepStrictEqual(r.user.topScores.map(s => s.score), [75], "guest score moved into the new account");
  r = await bob.post("/api/daily/status", {});
  assert.ok(r.json.state.done, "and today's run counts as played");

  // ---- Friends ----
  r = await alice.post("/api/friends/request", { username: "nobody" });
  assert.match(r.json.error, /No player/);
  r = await alice.post("/api/friends/request", { username: "alice" });
  assert.match(r.json.error, /yourself/);
  r = await alice.post("/api/friends/request", { username: "Bob" });
  assert.strictEqual(r.json.user.outgoing[0].username, "bob");
  r = await (await bob.get("/api/me")).json();
  assert.strictEqual(r.user.incoming[0].username, "alice", "Bob sees the request");
  r = await bob.post("/api/friends/accept", { id: r.user.incoming[0].id });
  assert.strictEqual(r.json.user.friends[0].username, "alice");
  r = await (await alice.get("/api/me")).json();
  assert.strictEqual(r.user.friends[0].username, "bob", "friendship goes both ways");
  assert.strictEqual(r.user.outgoing.length, 0);
  r = await alice.post("/api/daily/status", {});
  assert.deepStrictEqual(r.json.state.friendsBoard.map(e => e.name), ["Alice", "bob"], "friends leaderboard");
  const carol = browser();
  await carol.post("/api/auth/register", { username: "carol", password: "carols password" });
  await playDaily(carol, "celestillion", "carol-token-3333333333");
  r = await alice.post("/api/daily/status", {});
  assert.ok(!r.json.state.friendsBoard.some(e => e.name === "carol"), "non-friends aren't on the friends board");
  assert.ok(r.json.state.leaderboard.some(e => e.name === "carol"), "but are on the main board");
  // Requests that cross accept automatically; removing works both ways
  await carol.post("/api/friends/request", { username: "alice" });
  r = await alice.post("/api/friends/request", { username: "carol" });
  assert.ok(r.json.user.friends.some(f => f.username === "carol"), "mutual requests become friends");
  const carolId = r.json.user.friends.find(f => f.username === "carol").id;
  await alice.post("/api/friends/remove", { id: carolId });
  r = await (await carol.get("/api/me")).json();
  assert.strictEqual(r.user.friends.length, 0, "removing a friend removes it for both");

  // ---- Discord: new account ----
  const dee = browser();
  let res = await dee.get("/auth/discord");
  assert.strictEqual(res.status, 302);
  const toDiscord = new URL(res.headers.get("location"));
  assert.strictEqual(toDiscord.searchParams.get("scope"), "identify");
  assert.strictEqual(toDiscord.searchParams.get("redirect_uri"), `${BASE}/auth/discord/callback`);
  res = await dee.getFrom(toDiscord.href);                       // fake Discord approves
  const back = res.headers.get("location");
  res = await dee.getFrom(back);                                 // our callback
  assert.strictEqual(res.headers.get("location"), "/#account");
  r = await (await dee.get("/api/me")).json();
  assert.strictEqual(r.user.displayName, "Nelly");
  assert.strictEqual(r.user.username, "nelly");
  assert.deepStrictEqual(r.user.discord, { name: "nelly" });
  assert.strictEqual(r.user.hasPassword, false);
  r = await dee.post("/api/account/discord/unlink", {});
  assert.match(r.json.error, /password/, "can't disconnect Discord without a password");
  // Logging in with the same Discord again finds the same account
  const dee2 = browser();
  res = await dee2.get("/auth/discord");
  res = await dee2.getFrom(res.headers.get("location"));
  res = await dee2.getFrom(res.headers.get("location"));
  r = await (await dee2.get("/api/me")).json();
  assert.strictEqual(r.user.username, "nelly", "same Discord, same account");
  // A forged callback (wrong state) is refused
  res = await browser().get("/auth/discord/callback?code=good-code&state=forged");
  assert.match(res.headers.get("location"), /auth_error=discord_state/);

  // ---- Discord: linking to an existing account ----
  res = await carol.get("/auth/discord?link=1");
  res = await carol.getFrom(res.headers.get("location"));
  res = await carol.getFrom(res.headers.get("location"));
  assert.match(res.headers.get("location"), /discord_taken/, "a Discord account can only belong to one Celestillion account");

  // ---- Accounts survive a restart ----
  const { createAccounts: again } = require("./accounts");
  const reloaded = again(dir);
  // give the debounced save a moment
  await new Promise(r => setTimeout(r, 400));
  const fresh = again(dir);
  assert.ok(fresh.login("alice", "correct horse"), "accounts are saved to disk");

  console.log("Account checks passed.");
  server.close(); fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
