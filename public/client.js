// Phrase Hunt browser client. The server holds the answers and runs the game;
// this file only sends actions and draws whatever state the server broadcasts.
(() => {
  let TURN_MS = 20000;
  const COLORS = ["--p1", "--p2", "--p3", "--p4", "--p5", "--p6"];
  const socket = io();

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let token = store.get("ph-token");
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)) + "-" + Math.random().toString(36).slice(2);
    store.set("ph-token", token);
  }

  const S = { you: null, code: null, room: null, offset: 0, error: "", flash: null, seen: new Set(), connected: false, justSubmitted: false };
  // Daily challenge state. mode is "daily" while playing it; dstate is the latest state from the server.
  const D = { mode: null, dstate: null, last: null, error: "", busy: false, offset: 0, copied: false };
  let savedName = store.get("ph-name") || "";

  /* ---------- Server connection ---------- */
  function call(event, data = {}) {
    return new Promise(resolve => socket.timeout(8000).emit(event, data, (err, res) => {
      resolve(err ? { ok: false, error: "The server didn't answer. Check your connection and try again." } : res);
    }));
  }

  socket.on("connect", async () => {
    S.connected = true;
    const r = await call("hello", { token });
    if (r.ok) S.you = r.you;
    if (r.displayName) savedName = r.displayName;
    if (S.code && savedName) {
      const j = await call("join", { code: S.code, name: savedName });
      if (!j.ok) { S.error = j.error; S.code = null; S.room = null; }
      else applyState(j.state);
    }
    render();
    autoJoinFromLink();
  });
  socket.on("disconnect", () => { S.connected = false; render(); });

  socket.on("state", applyState);
  function applyState(room) {
    if (!room || !S.code || room.code !== S.code) return;
    S.offset = room.serverNow - Date.now();
    if (room.status === "playing" && S.room?.status !== "playing") { S.flash = null; }
    if (room.game && S.room?.game && room.game.turnNo !== S.room.game.turnNo) S.justSubmitted = true; // clear the box for the next turn
    S.room = room;
    if (room.turnMs) TURN_MS = room.turnMs;
    render();
  }

  let autoTried = false;
  function autoJoinFromLink() {
    if (autoTried) return;
    autoTried = true;
    const h = (location.hash || "").slice(1).toUpperCase();
    if (!/^[A-Z]{4}$/.test(h) || S.code) return;
    const jc = document.getElementById("jc");
    if (jc) jc.value = h;
    if (savedName) document.getElementById("join")?.click();
  }

  /* ---------- Actions ---------- */
  function readName() {
    if (A.user) return A.user.displayName;
    const n = (document.getElementById("nm")?.value || "").trim();
    if (!n) throw new Error("Enter your name first.");
    savedName = n;
    store.set("ph-name", n);
    return n;
  }
  async function guard(fn) {
    S.error = "";
    try { await fn(); } catch (e) { S.error = e.message || String(e); }
    render();
  }
  async function must(event, data) {
    const r = await call(event, data);
    if (!r.ok) throw new Error(r.error || "Something went wrong.");
    return r;
  }
  function enterRoom(code) {
    S.code = code;
    try { history.replaceState(null, "", "#" + code); } catch {}
  }
  async function leaveRoom() {
    await call("leave");
    S.code = null; S.room = null; S.flash = null; S.error = "";
    try { history.replaceState(null, "", location.pathname); } catch {}
    render();
  }
  async function submitGuess(text) {
    const turnNo = S.room?.game?.turnNo;
    const r = await call("guess", { text });
    if (!r.ok) { S.error = r.error; render(); return; }
    const res = r.result;
    if (!res.ok) {
      // Wrong or repeated: the turn and the clock carry on, so show it until the turn changes.
      const msg = res.why === "already said"
        ? `“${res.answer}” was already said${res.by ? " by " + nameOf(res.by) : ""}. Try another.`
        : res.why === "not on the list" ? `“${res.text}” isn't on the list. Try another.` : "";
      S.flash = msg ? { ok: false, msg, turnNo } : null;
      render();
    }
  }

  /* ---------- Turn clock (display only; the server enforces time) ---------- */
  setInterval(() => {
    const g = S.room?.game;
    if (!g || S.room.status !== "playing") return;
    const left = Math.max(0, g.turnEndsAt - (Date.now() + S.offset));
    const nextIn = document.getElementById("nextIn");
    if (nextIn) nextIn.textContent = Math.max(0, Math.ceil((g.nextRoundAt - (Date.now() + S.offset)) / 1000));
    const bar = document.getElementById("timerBar"), secs = document.getElementById("secs");
    if (bar) { bar.style.width = (left / TURN_MS * 100) + "%"; bar.parentElement.classList.toggle("low", left < 8000); }
    if (secs) secs.textContent = Math.ceil(left / 1000) + "s";
  }, 250);

  /* ---------- Rendering ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const playerList = () => S.room?.players ?? [];
  const nameOf = id => playerList().find(p => p.id === id)?.name || "Player";
  function colorOf(id) {
    const order = S.room?.game?.order ?? playerList().map(p => p.id);
    const i = order.indexOf(id);
    return `var(${COLORS[(i < 0 ? 0 : i) % COLORS.length]})`;
  }

  function render() {
    const conn = document.getElementById("conn");
    conn.textContent = S.connected ? "" : "Connecting to the server…";
    conn.classList.toggle("bad", !S.connected);

    const acct = document.getElementById("acct");
    if (acct) acct.innerHTML = viewAccountButton();
    const app = document.getElementById("app");
    const focusId = document.activeElement?.id;
    const draft = document.getElementById("guess")?.value;
    const typed = { nm: document.getElementById("nm")?.value, jc: document.getElementById("jc")?.value, dnm: document.getElementById("dnm")?.value, danswer: document.getElementById("danswer")?.value, au: document.getElementById("au")?.value, fname: document.getElementById("fname")?.value };
    if (A.view === "login" && !A.user) app.innerHTML = viewLogin();
    else if (A.view === "account" || (A.view === "login" && A.user)) app.innerHTML = viewAccount();
    else if (D.mode === "daily") app.innerHTML = viewDaily();
    else if (!S.code || !S.room) app.innerHTML = viewStart();
    else if (S.room.status === "lobby") app.innerHTML = viewLobby();
    else app.innerHTML = viewGame();
    const gi = document.getElementById("guess");
    if (gi && draft && !S.justSubmitted) gi.value = draft;
    S.justSubmitted = false;
    for (const [id, v] of Object.entries(typed)) { const el = document.getElementById(id); if (el && v) el.value = v; }
    const f = focusId && document.getElementById(focusId);
    if (f && !f.disabled) f.focus();
    else if (gi && !gi.disabled) gi.focus();
    else document.getElementById("danswer")?.focus();
    wire();
    wireDaily();
    wireAuth();
  }

  function viewStart() {
    return `${viewDailyCard()}<div class="lobby">
      <section class="panel">
        <h2>Play with friends</h2>
        ${A.user ? `<p class="mode-note">Playing as <b>${esc(A.user.displayName)}</b>.</p>` : `<label class="label" for="nm">Your name</label>
        <input type="text" id="nm" maxlength="18" value="${esc(savedName)}" placeholder="e.g. Sam">`}
        <div class="row"><button id="create" ${S.connected ? "" : "disabled"}>Create a room</button></div>
        <label class="label" for="jc">Or join with a room code</label>
        <div class="row"><input type="text" id="jc" maxlength="4" placeholder="ABCD" style="text-transform:uppercase;font-family:var(--mono)"><button class="ghost" id="join" ${S.connected ? "" : "disabled"}>Join</button></div>
        <p class="err">${esc(S.error)}</p>
      </section>
      <section class="panel">
        <h2>How to play</h2>
        <ul class="rules">
          <li>Each round is a question with a hidden list of answers, like "Name a dog breed".</li>
          <li>Take turns. You have ${TURN_MS / 1000} seconds to give an answer nobody has said yet this round.</li>
          <li>Wrong answers don't cost anything, so keep guessing until the clock runs out.</li>
          <li>Run out of time and you lose one of your 3 hearts and sit out the rest of the round.</li>
          <li>After the 2nd heart is lost in a round, play continues until it gets back to whoever started the round. Then a new question begins and everyone is back in.</li>
          <li>The last player with hearts left wins.</li>
        </ul>
      </section>
    </div>`;
  }

  function viewLobby() {
    const r = S.room, isHost = r.host === S.you;
    const link = location.origin + location.pathname + "#" + r.code;
    return `<div class="lobby">
      <section class="panel">
        <p class="label">Room code</p>
        <div class="row"><span class="code">${esc(r.code)}</span><button class="ghost" id="copy">Copy invite link</button></div>
        <p class="mode-note">Send friends this link: <span id="linkTxt">${esc(link)}</span></p>
        <p class="label">Players (${r.players.length}/6)</p>
        <ul class="players">${r.players.map(p => `<li><span class="dot" style="background:${colorOf(p.id)}"></span><span class="pname">${esc(p.name)}${p.id === S.you ? " (you)" : ""}${r.host === p.id ? " · host" : ""}${p.connected ? "" : " · reconnecting"}</span><span></span><span></span></li>`).join("")}</ul>
        <div class="row">
          ${isHost ? `<button id="start">Start game</button>` : `<p class="mode-note">Waiting for the host to start.</p>`}
          <button class="ghost" id="leave">Leave</button>
        </div>
        <p class="err">${esc(S.error)}</p>
      </section>
    </div>`;
  }

  function viewGame() {
    const r = S.room, g = r.game, over = r.status === "over", phase = g.phase;
    const round = g.round;
    const cur = g.order[g.turn], myTurn = !over && phase === "turn" && cur === S.you;
    const inGame = g.order.includes(S.you);
    const isHost = r.host === S.you;
    const now = Date.now() + S.offset;
    const left = Math.max(0, g.turnEndsAt - now);
    const heartRow = id => `${"♥".repeat(Math.max(0, g.hearts[id]))}<span class="lost">${"♥".repeat(Math.max(0, r.hearts - g.hearts[id]))}</span>`;
    const chips = list => list.map(s => `<li class="said" style="--pc:${colorOf(s.pid)}"><span>${esc(s.text)}</span><small>${esc(nameOf(s.pid))}</small></li>`).join("");
    const missedChips = list => list.map(m => `<li class="chip t-${m.tier}">${esc(m.text)}</li>`).join("");

    let main;
    if (phase === "turn") {
      main = `<section class="panel mq">
        <div class="mq-head"><span class="label">Round ${g.roundNo}</span><span class="label">Started by ${esc(nameOf(round.starter))} · ${Math.min(round.losses, 2)} of 2 hearts lost</span></div>
        <h2 class="dq-text">${esc(round.question)}</h2>
        <div class="turnline">
          <span class="turn-name" style="color:${colorOf(cur)}">${myTurn ? "Your turn" : esc(nameOf(cur)) + "'s turn"}</span>
          <span class="secs" id="secs">${Math.ceil(left / 1000)}s</span>
        </div>
        <div class="timer"><i id="timerBar" style="width:${left / TURN_MS * 100}%"></i></div>
        <form id="guessForm" class="row" autocomplete="off">
          <input type="text" id="guess" maxlength="80" placeholder="${myTurn ? "Type a new answer…" : "Wait for your turn"}" ${myTurn ? "" : "disabled"} aria-label="Your answer">
          <button type="submit" ${myTurn ? "" : "disabled"}>Say it</button>
        </form>
        ${S.flash && S.flash.turnNo === g.turnNo ? `<div class="flash ${S.flash.ok ? "ok" : "no"}">${esc(S.flash.msg)}</div>` : ""}
        ${!inGame ? `<p class="mode-note">You joined after the start, so you're watching this game.</p>` : ""}
        <div>
          <p class="label">Said this round (${round.said.length})</p>
          <ul class="said-list">${chips(round.said) || `<li class="mode-note">No answers yet.</li>`}</ul>
        </div>
      </section>`;
    } else {
      const lr = g.lastRound;
      const until = Math.max(0, Math.ceil((g.nextRoundAt - now) / 1000));
      main = `<section class="panel mq">
        ${over ? `<p class="label">Game over</p>
          <div class="winner">${g.winner ? esc(nameOf(g.winner)) + " wins" : g.order.length === 1 ? `You made it to round ${g.roundNo}` : "No one is left"}</div>
          <div class="row">${isHost ? `<button id="again">Back to lobby</button>` : `<p class="mode-note">The host can start a new game.</p>`}<button class="ghost" id="leave">Leave room</button></div>`
        : `<div class="mq-head"><span class="label">Round ${lr?.roundNo ?? g.roundNo} over</span><span class="label">Next question in <span id="nextIn">${until}</span>s</span></div>`}
        ${lr ? `<h2 class="dq-text">${esc(lr.question)}</h2>
          <div><p class="label">Said (${lr.said.length})</p><ul class="said-list">${chips(lr.said) || `<li class="mode-note">Nobody found an answer.</li>`}</ul></div>
          <div><p class="label">Some answers nobody said</p><ul class="said-list">${missedChips(lr.missed)}</ul></div>` : ""}
      </section>`;
    }

    const statusOf = id => {
      if (g.hearts[id] <= 0) return "out of the game";
      if (phase === "turn" && round.out.includes(id)) return "sitting out";
      return "";
    };
    return `<div class="stage">
      ${main}
      <aside class="side">
        <section class="panel">
          <p class="label">Players</p>
          <ul class="players hearts">${g.order.map(id => `<li class="${phase === "turn" && id === cur ? "now" : ""} ${g.hearts[id] <= 0 ? "out" : ""} ${phase === "turn" && round.out.includes(id) && g.hearts[id] > 0 ? "sitting" : ""}">
            <span class="dot" style="background:${colorOf(id)}"></span>
            <span class="pname">${esc(nameOf(id))}${id === S.you ? " (you)" : ""}${statusOf(id) ? `<small> · ${statusOf(id)}</small>` : ""}${phase === "turn" && round.starter === id ? `<small> · started</small>` : ""}</span>
            <span class="lives" aria-label="${g.hearts[id]} hearts">${heartRow(id)}</span></li>`).join("")}</ul>
        </section>
        <section class="panel">
          <p class="label">How rounds work</p>
          <ul class="rules">
            <li>You have ${TURN_MS / 1000} seconds to give an answer nobody has said this round.</li>
            <li>Wrong answers don't cost anything. Keep trying until time runs out.</li>
            <li>Run out of time and you lose a heart and sit out the rest of the round.</li>
            <li>After the 2nd heart is lost, the round ends when the turn gets back to whoever started it.</li>
          </ul>
        </section>
        <p class="err">${esc(S.error)}</p>
      </aside>
    </div>`;
  }

  function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function wire() {
    on("create", "click", () => guard(async () => {
      const name = readName();
      const r = await must("create", { name });
      enterRoom(r.code);
      applyState(r.state);
    }));
    on("join", "click", () => guard(async () => {
      const name = readName();
      const code = (document.getElementById("jc").value || "").trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) throw new Error("Room codes are 4 letters.");
      enterRoom(code);
      try { applyState((await must("join", { code, name })).state); }
      catch (e) { S.code = null; throw e; }
    }));
    on("jc", "keydown", e => { if (e.key === "Enter") document.getElementById("join").click(); });
    on("nm", "keydown", e => { if (e.key === "Enter") document.getElementById("create").click(); });
    on("start", "click", () => guard(() => must("start")));
    on("again", "click", () => guard(() => must("lobby")));
    on("leave", "click", leaveRoom);
    on("copy", "click", e => {
      const link = document.getElementById("linkTxt").textContent;
      navigator.clipboard?.writeText(link).then(() => { e.target.textContent = "Copied"; }, () => {
        const rg = document.createRange(); rg.selectNodeContents(document.getElementById("linkTxt"));
        getSelection().removeAllRanges(); getSelection().addRange(rg);
      });
    });
    on("guessForm", "submit", e => {
      e.preventDefault();
      const v = document.getElementById("guess").value.trim();
      if (!v) return;
      S.justSubmitted = true;
      submitGuess(v);
    });
  }

  /* ================= Daily challenge (single player) ================= */
  const TIER_EMOJI = { refill: "🟩", spinner: "🟦", pufferfish: "🟨", seeker: "🟪", celestillion: "⭐" };
  async function api(pathName, body) {
    try {
      const res = await fetch("/api/daily/" + pathName, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const json = await res.json();
      if (json.state) { D.dstate = json.state; D.offset = json.state.serverNow - Date.now(); }
      return json;
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  }
  const serverNow = () => Date.now() + D.offset;
  const tierOf = key => D.dstate?.tiers.find(t => t.key === key);
  const maxScore = () => (D.dstate?.perDay ?? 5) * 100;
  function untilReset() {
    const ms = Math.max(0, (D.dstate?.resetsAt ?? 0) - serverNow());
    const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1000) % 60;
    return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  }
  // Which screen of the daily challenge to show.
  function dailyPhase() {
    const st = D.dstate;
    if (!st) return "loading";
    if (D.last) return "result";
    if (st.current) return "question";
    if (st.done) return "summary";
    return "intro";
  }
  function shareText() {
    const st = D.dstate;
    const squares = st.results.map(r => TIER_EMOJI[r.tier] || "⬛").join("");
    return `CELESTILLION Daily #${st.day}\n${squares} ${st.total}/${maxScore()}\n${location.origin}`;
  }

  function viewDailyCard() {
    const st = D.dstate;
    const played = st?.results.length ?? 0;
    const label = !st ? "Loading today's challenge…"
      : st.done ? "You've played today's challenge."
      : played ? `You're on question ${played + 1} of ${st.perDay}.`
      : `${st.perDay} new questions. ${st.answerMs / 1000} seconds and one answer for each.`;
    const btn = !st ? "" : st.done ? "See your results" : played ? "Continue" : "Play today's challenge";
    return `<section class="panel daily-card">
      <div class="daily-head">
        <div><p class="label">Daily challenge${st ? " · #" + st.day : ""}</p><h2>${esc(label)}</h2></div>
        <p class="mode-note">New questions in <span class="reset-in">${st ? untilReset() : "…"}</span></p>
      </div>
      ${st && !st.done && !played && !A.user ? `<div class="row"><input type="text" id="dnm" maxlength="18" value="${esc(savedName)}" placeholder="Your name for the leaderboard" aria-label="Your name"><button id="dplay">${btn}</button></div>`
        : st ? `<div class="row"><button id="dplay">${btn}</button></div>` : ""}
      ${D.error ? `<p class="err">${esc(D.error)}</p>` : ""}
    </section>`;
  }
  function tierLegend() {
    const tiers = D.dstate?.tiers ?? [];
    return `<ul class="tiers" aria-label="Points for each kind of answer">${tiers.map(t => `<li class="tier t-${t.key}"><span class="tname">${esc(t.name)}</span><span class="tpts">${t.points}</span></li>`).join("")}</ul>`;
  }

  function viewDaily() {
    const st = D.dstate, phase = dailyPhase();
    const head = st ? `<div class="daily-bar"><button class="ghost" id="dback">Back</button><span class="label">Daily #${st.day}</span><span class="dtotal">${st.total}<small> / ${maxScore()}</small></span></div>` : "";
    let body = "";
    if (phase === "loading") body = `<section class="panel"><p class="mode-note">Loading…</p></section>`;
    else if (phase === "intro") body = viewDailyCard();
    else if (phase === "question") {
      const c = st.current, left = Math.max(0, c.deadline - serverNow());
      body = `<section class="panel dq">
        <p class="label">Question ${c.index + 1} of ${st.perDay}</p>
        <h2 class="dq-text">${esc(c.question)}</h2>
        <div class="row" style="justify-content:space-between"><span class="label">One answer · rarer answers score more</span><span class="secs" id="dsecs">${Math.ceil(left / 1000)}s</span></div>
        <div class="timer"><i id="dtimer" style="width:${left / st.answerMs * 100}%"></i></div>
        <form id="dform" class="row" autocomplete="off">
          <input type="text" id="danswer" maxlength="80" placeholder="Type your answer…" aria-label="Your answer" ${D.busy ? "disabled" : ""}>
          <button type="submit" ${D.busy ? "disabled" : ""}>Lock it in</button>
        </form>
        ${tierLegend()}
        ${D.error ? `<p class="err">${esc(D.error)}</p>` : ""}
      </section>`;
    } else if (phase === "result") {
      const r = D.last, t = tierOf(r.tier), last = st.results.length >= st.perDay;
      body = `<section class="panel dres ${t ? "t-" + t.key : "miss"}">
        <p class="label">Question ${st.results.length} of ${st.perDay}</p>
        <div class="dres-pts">${t ? "+" + t.points : "0"}</div>
        <div class="dres-tier">${t ? esc(t.name) : r.timedOut ? "Time's up" : "Not on the list"}</div>
        <p class="mode-note">${r.text ? `You answered “${esc(r.text)}”${t && r.answer && r.answer.toLowerCase() !== r.text.toLowerCase() ? `, counted as “${esc(r.answer)}”` : ""}.` : "You didn't answer in time."}</p>
        <div class="row"><button id="dnext">${last ? "See today's results" : "Next question"}</button></div>
      </section>`;
    } else {
      const rows = st.results.map((r, i) => {
        const t = tierOf(r.tier);
        return `<li><span class="dsum-q">${i + 1}. ${esc(r.question)}</span><span class="dsum-a">${r.text ? esc(r.answer || r.text) : "No answer"}</span><span class="chip ${t ? "t-" + t.key : "miss"}">${t ? esc(t.name) : "Miss"}</span><span class="dsum-p">${r.points}</span></li>`;
      }).join("");
      const lbRows = list => list.map(e => `<li class="${e.id === st.you ? "me" : ""}"><span class="rank">${e.rank}</span><span class="pname">${esc(e.name)}${e.id === st.you ? " (you)" : ""}</span><span class="score">${e.score}</span></li>`).join("");
      const lb = st.leaderboard.map(e => `<li class="${e.id === st.you ? "me" : ""}"><span class="rank">${e.rank}</span><span class="pname">${esc(e.name)}${e.id === st.you ? " (you)" : ""}</span><span class="score">${e.score}</span></li>`).join("");
      body = `<div class="dsum">
        <section class="panel">
          <p class="label">Today's score</p>
          <div class="dsum-total">${st.total}<small> / ${maxScore()}</small></div>
          <p class="mode-note">${st.rank ? `You're #${st.rank} of ${st.players} ${st.players === 1 ? "player" : "players"} today. ` : ""}New questions in <span class="reset-in">${untilReset()}</span>.</p>
          <ul class="dsum-list">${rows}</ul>
        </section>
        <aside class="side">
          <section class="panel">
            <p class="label">Share your score</p>
            <pre class="share" id="shareTxt">${esc(shareText())}</pre>
            <div class="row"><button id="dshare">${D.copied ? "Copied" : "Copy"}</button></div>
          </section>
          <section class="panel">
            <div class="lb-head"><p class="label">Today's leaderboard</p>
              ${st.friendsBoard ? `<div class="tabs small-tabs" role="tablist"><button role="tab" class="tab ${A.lbTab === "all" ? "on" : ""}" id="lbAll">Everyone</button><button role="tab" class="tab ${A.lbTab === "friends" ? "on" : ""}" id="lbFriends">Friends</button></div>` : ""}</div>
            <ol class="lb">${(A.lbTab === "friends" && st.friendsBoard ? lbRows(st.friendsBoard) : lb) || `<li class="mode-note">${A.lbTab === "friends" && st.friendsBoard ? "None of your friends have played today yet." : "No scores yet."}</li>`}</ol>
            ${A.user ? "" : `<p class="mode-note"><a href="#login" id="lbLogin">Log in</a> to save your top scores and compare with friends.</p>`}
          </section>
        </aside>
      </div>`;
    }
    return head + body;
  }

  async function dailyStart() {
    D.error = "";
    const el = document.getElementById("dnm");
    const name = A.user ? A.user.displayName : ((el ? el.value : savedName).trim() || savedName);
    if (!name && !D.dstate?.done) { D.error = "Enter a name for the leaderboard first."; render(); return; }
    if (name) { savedName = name; store.set("ph-name", name); }
    D.mode = "daily";
    if (!D.dstate?.done && !D.dstate?.current) await dailyNext();
    render();
  }
  async function dailyNext() {
    D.last = null;
    D.busy = true; render();
    const r = await api("next", { name: savedName });
    D.busy = false;
    if (!r.ok) D.error = r.error;
    render();
  }
  async function dailySubmit(text) {
    if (D.busy || !D.dstate?.current) return;
    D.busy = true; D.error = ""; render();
    const r = await api("answer", { text, name: savedName });
    D.busy = false;
    D.last = r.state?.last ?? null;
    if (!r.ok && !D.last) D.error = r.error;
    render();
  }
  function wireDaily() {
    on("dplay", "click", dailyStart);
    on("dnm", "keydown", e => { if (e.key === "Enter") dailyStart(); });
    on("dback", "click", () => { D.mode = null; D.last = null; D.error = ""; render(); });
    on("dnext", "click", () => {
      if (D.dstate.results.length >= D.dstate.perDay) { D.last = null; render(); }
      else dailyNext();
    });
    on("dform", "submit", e => { e.preventDefault(); dailySubmit(document.getElementById("danswer").value.trim()); });
    on("dshare", "click", () => {
      const text = shareText();
      navigator.clipboard?.writeText(text).then(() => { D.copied = true; render(); setTimeout(() => { D.copied = false; render(); }, 2000); }, () => {
        const rg = document.createRange(); rg.selectNodeContents(document.getElementById("shareTxt"));
        getSelection().removeAllRanges(); getSelection().addRange(rg);
      });
    });
  }

  // Daily clock: updates the countdowns, submits whatever is typed when time runs out,
  // and reloads the challenge after the 00:00 UTC reset.
  let lastDay = null;
  setInterval(() => {
    const st = D.dstate;
    if (!st) return;
    document.querySelectorAll(".reset-in").forEach(el => { el.textContent = untilReset(); });
    if (st.current && dailyPhase() === "question") {
      const left = Math.max(0, st.current.deadline - serverNow());
      const bar = document.getElementById("dtimer"), secs = document.getElementById("dsecs");
      if (bar) { bar.style.width = (left / st.answerMs * 100) + "%"; bar.parentElement.classList.toggle("low", left < 8000); }
      if (secs) secs.textContent = Math.ceil(left / 1000) + "s";
      if (left === 0 && !D.busy) dailySubmit((document.getElementById("danswer")?.value || "").trim());
    }
    if (serverNow() >= st.resetsAt && lastDay === st.day) {
      lastDay = null; D.last = null; D.mode = D.mode === "daily" ? "daily" : null;
      api("status", {}).then(() => { lastDay = D.dstate?.day; render(); });
    }
  }, 250);
  api("status", {}).then(() => { lastDay = D.dstate?.day; render(); });

  /* ================= Optional accounts ================= */
  // A.user is the signed-in account (or null for guests). view is "login" or "account" when those pages are open.
  const A = { user: null, discord: false, loaded: false, view: null, tab: "login", error: "", note: "", busy: false, lbTab: "all" };
  const AUTH_ERRORS = {
    discord_off: "Discord login isn't set up on this server yet.",
    discord_cancelled: "Discord login was cancelled.",
    discord_state: "That Discord login link expired. Try again.",
    discord_failed: "Discord didn't let us log you in. Try again in a moment.",
    discord_taken: "That Discord account is already used by another Celestillion account.",
  };
  async function authApi(pathName, body = {}) {
    try {
      const res = await fetch(pathName, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
      const json = await res.json();
      if (json.user !== undefined) A.user = json.user;
      return json;
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  }
  async function loadMe() {
    try {
      const r = await (await fetch("/api/me", { cache: "no-store" })).json();
      A.user = r.user; A.discord = !!r.discord;
    } catch {}
    A.loaded = true;
  }
  // After logging in or out, reconnect so multiplayer and the daily challenge use the new identity.
  async function identityChanged() {
    socket.disconnect(); socket.connect();
    await api("status", {});
    render();
  }
  function openView(v) {
    A.view = v; A.error = ""; A.note = "";
    try { history.replaceState(null, "", v ? "#" + v : location.pathname); } catch {}
    window.scrollTo(0, 0);
    render();
    // Refresh scores and friend requests whenever the account page opens.
    if (v === "account" && A.user) loadMe().then(render);
  }

  function viewAccountButton() {
    if (!A.loaded) return "";
    return A.user
      ? `<button class="ghost acct-btn" id="openAccount" aria-label="Your account">${esc(A.user.displayName)}</button>`
      : `<button class="ghost acct-btn" id="openLogin">Log in</button>`;
  }

  function viewLogin() {
    const reg = A.tab === "register";
    return `<div class="auth-wrap">
      <div class="daily-bar"><button class="ghost" id="authBack">Back</button></div>
      <section class="panel auth">
        <h2>${reg ? "Create an account" : "Log in"}</h2>
        <p class="mode-note">An account is optional. It saves your top 5 daily scores and lets you add friends. You can keep playing as a guest.</p>
        <div class="tabs" role="tablist">
          <button role="tab" class="tab ${reg ? "" : "on"}" id="tabLogin" aria-selected="${!reg}">Log in</button>
          <button role="tab" class="tab ${reg ? "on" : ""}" id="tabRegister" aria-selected="${reg}">Create account</button>
        </div>
        <form id="authForm" class="auth-form" autocomplete="on">
          <label class="label" for="au">Username</label>
          <input type="text" id="au" name="username" autocomplete="username" maxlength="20" autocapitalize="none" spellcheck="false" required>
          <label class="label" for="ap">Password</label>
          <input type="password" id="ap" name="password" autocomplete="${reg ? "new-password" : "current-password"}" minlength="${reg ? 8 : 1}" maxlength="200" required>
          ${reg ? `<p class="mode-note">3–20 letters, numbers, dots, dashes or underscores. Passwords need at least 8 characters. No email needed, so keep your password somewhere safe: it can't be reset.</p>` : ""}
          <button type="submit" ${A.busy ? "disabled" : ""}>${reg ? "Create account" : "Log in"}</button>
        </form>
        ${A.discord ? `<div class="or"><span>or</span></div><button class="discord" id="discordLogin">Continue with Discord</button>` : ""}
        ${A.error ? `<p class="err">${esc(A.error)}</p>` : ""}
      </section>
    </div>`;
  }

  function viewAccount() {
    const u = A.user;
    if (!u) return viewLogin();
    const top = u.topScores.length
      ? `<ol class="top5">${u.topScores.map((s, i) => `<li><span class="rank">${i + 1}</span><span>Daily #${s.day}</span><span class="score">${s.score}<small> / 500</small></span></li>`).join("")}</ol>`
      : `<p class="mode-note">Finish a daily challenge to see your best scores here.</p>`;
    const person = (f, buttons) => `<li><span class="pname">${esc(f.displayName)} <small>@${esc(f.username)}</small></span><span class="row">${buttons}</span></li>`;
    return `<div class="auth-wrap">
      <div class="daily-bar"><button class="ghost" id="authBack">Back</button><span class="label">Your account</span><button class="ghost" id="logout">Log out</button></div>
      ${A.note ? `<p class="flash ok">${esc(A.note)}</p>` : ""}
      ${A.error ? `<p class="err">${esc(A.error)}</p>` : ""}
      <div class="acct-grid">
        <section class="panel">
          <p class="label">Display name</p>
          <form id="nameForm" class="row">
            <input type="text" id="dname" maxlength="18" value="${esc(u.displayName)}" aria-label="Display name" required>
            <button type="submit">Save</button>
          </form>
          <p class="mode-note">This is the name other players see. Your username is <b>@${esc(u.username)}</b>; friends use it to add you.</p>
        </section>

        <section class="panel">
          <p class="label">Your top 5 daily scores</p>
          ${top}
          <p class="mode-note">${u.gamesPlayed} daily ${u.gamesPlayed === 1 ? "challenge" : "challenges"} played.</p>
        </section>

        <section class="panel">
          <p class="label">Friends</p>
          <form id="friendForm" class="row" autocomplete="off">
            <input type="text" id="fname" maxlength="20" placeholder="Friend's username" aria-label="Friend's username" autocapitalize="none" spellcheck="false">
            <button type="submit">Send request</button>
          </form>
          ${u.incoming.length ? `<p class="label">Requests for you</p><ul class="people">${u.incoming.map(f => person(f, `<button class="small" data-accept="${f.id}">Accept</button><button class="ghost small" data-drop="${f.id}">Decline</button>`)).join("")}</ul>` : ""}
          ${u.outgoing.length ? `<p class="label">Waiting for them to accept</p><ul class="people">${u.outgoing.map(f => person(f, `<button class="ghost small" data-drop="${f.id}">Cancel</button>`)).join("")}</ul>` : ""}
          <p class="label">Your friends (${u.friends.length})</p>
          ${u.friends.length ? `<ul class="people">${u.friends.map(f => person(f, `<button class="ghost small" data-drop="${f.id}" data-confirm="Remove ${esc(f.displayName)}?">Remove</button>`)).join("")}</ul>`
            : `<p class="mode-note">No friends yet. Friends show up on a Friends tab of the daily leaderboard.</p>`}
        </section>

        <section class="panel">
          <p class="label">Discord</p>
          ${u.discord ? `<p>Connected as <b>${esc(u.discord.name)}</b>.</p>
              ${u.hasPassword ? `<div class="row"><button class="ghost" id="discordUnlink">Disconnect Discord</button></div>` : `<p class="mode-note">Set a password below before disconnecting, so you can still log in.</p>`}`
            : A.discord ? `<p class="mode-note">Connect Discord to log in with it next time.</p><div class="row"><button class="discord" id="discordLink">Connect Discord</button></div>`
            : `<p class="mode-note">Discord login isn't set up on this server yet.</p>`}
          <p class="label">${u.hasPassword ? "Change password" : "Set a password"}</p>
          <form id="pwForm" class="auth-form">
            <input type="text" name="username" autocomplete="username" value="${esc(u.username)}" hidden>
            ${u.hasPassword ? `<input type="password" id="pwCur" autocomplete="current-password" placeholder="Current password" aria-label="Current password" required>` : ""}
            <input type="password" id="pwNew" autocomplete="new-password" minlength="8" placeholder="New password (8+ characters)" aria-label="New password" required>
            <button type="submit" class="ghost">${u.hasPassword ? "Change password" : "Set password"}</button>
          </form>
        </section>
      </div>
    </div>`;
  }

  function wireAuth() {
    on("openLogin", "click", () => openView("login"));
    on("openAccount", "click", () => openView("account"));
    on("authBack", "click", () => openView(null));
    on("tabLogin", "click", () => { A.tab = "login"; A.error = ""; render(); });
    on("tabRegister", "click", () => { A.tab = "register"; A.error = ""; render(); });
    on("authForm", "submit", async e => {
      e.preventDefault();
      if (A.busy) return;
      // Read the fields before redrawing, which clears the password box.
      const creds = { username: document.getElementById("au").value, password: document.getElementById("ap").value };
      A.busy = true; A.error = ""; render();
      const r = await authApi(A.tab === "register" ? "/api/auth/register" : "/api/auth/login", creds);
      A.busy = false;
      if (!r.ok) { A.error = r.error; render(); return; }
      savedName = A.user.displayName;
      A.view = "account"; A.note = A.tab === "register" ? "Account created. You're logged in." : "";
      try { history.replaceState(null, "", "#account"); } catch {}
      await identityChanged();
    });
    const toDiscord = link => {
      // Pass this browser's guest id along so today's daily run moves to the account.
      document.cookie = `cel_guest=${encodeURIComponent(token)}; Path=/; Max-Age=600; SameSite=Lax`;
      location.href = "/auth/discord" + (link ? "?link=1" : "");
    };
    on("discordLogin", "click", () => toDiscord(false));
    on("discordLink", "click", () => toDiscord(true));
    on("logout", "click", async () => {
      await authApi("/api/auth/logout");
      A.user = null;
      openView(null);
      await identityChanged();
    });
    const accountAction = async (pathName, body, note) => {
      A.error = ""; A.note = "";
      const r = await authApi(pathName, body);
      if (!r.ok) A.error = r.error; else A.note = note;
      render();
      return r;
    };
    on("nameForm", "submit", async e => {
      e.preventDefault();
      const r = await accountAction("/api/account/name", { displayName: document.getElementById("dname").value }, "Display name saved.");
      if (r.ok) { savedName = A.user.displayName; api("status", {}).then(render); }
    });
    on("friendForm", "submit", async e => {
      e.preventDefault();
      const name = document.getElementById("fname").value.trim();
      if (!name) return;
      const r = await accountAction("/api/friends/request", { username: name }, "");
      if (r.ok) {
        const nowFriend = A.user.friends.some(f => f.username === name.toLowerCase());
        A.note = nowFriend ? "You're now friends." : "Friend request sent.";
        render();
      }
    });
    document.querySelectorAll("[data-accept]").forEach(b => b.addEventListener("click", () =>
      accountAction("/api/friends/accept", { id: b.dataset.accept }, "Friend added.")));
    document.querySelectorAll("[data-drop]").forEach(b => b.addEventListener("click", () => {
      // The viewer can't show confirm(), so removing a friend takes a second click.
      if (b.dataset.confirm && b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to remove"; return; }
      accountAction("/api/friends/remove", { id: b.dataset.drop }, "");
    }));
    on("discordUnlink", "click", () => accountAction("/api/account/discord/unlink", {}, "Discord disconnected."));
    on("pwForm", "submit", async e => {
      e.preventDefault();
      const body = { current: document.getElementById("pwCur")?.value, next: document.getElementById("pwNew").value };
      await accountAction("/api/account/password", body, "Password saved.");
    });
    on("lbLogin", "click", e => { e.preventDefault(); D.mode = null; openView("login"); });
    on("lbAll", "click", () => { A.lbTab = "all"; render(); });
    on("lbFriends", "click", () => { A.lbTab = "friends"; render(); });
  }

  // Start-up: read ?auth_error= from a Discord redirect and open #login / #account pages.
  (() => {
    const params = new URLSearchParams(location.search);
    const err = params.get("auth_error");
    const h = location.hash.slice(1);
    if (h === "login" || h === "account") A.view = h;
    if (err) {
      A.error = AUTH_ERRORS[err] || "Login failed. Try again.";
      try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
    }
  })();
  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if ((h === "login" || h === "account") && A.view !== h) { A.view = h; render(); }
  });
  loadMe().then(async () => { if (A.user) savedName = A.user.displayName; render(); });

  render();
})();
