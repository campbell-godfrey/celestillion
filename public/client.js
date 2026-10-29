// Phrase Hunt browser client. The server holds the answers and runs the game;
// this file only sends actions and draws whatever state the server broadcasts.
(() => {
  let TURN_MS = 30000;
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

    const app = document.getElementById("app");
    const focusId = document.activeElement?.id;
    const draft = document.getElementById("guess")?.value;
    const typed = { nm: document.getElementById("nm")?.value, jc: document.getElementById("jc")?.value, dnm: document.getElementById("dnm")?.value, danswer: document.getElementById("danswer")?.value };
    if (D.mode === "daily") app.innerHTML = viewDaily();
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
  }

  function viewStart() {
    return `${viewDailyCard()}<div class="lobby">
      <section class="panel">
        <h2>Play with friends</h2>
        <label class="label" for="nm">Your name</label>
        <input type="text" id="nm" maxlength="18" value="${esc(savedName)}" placeholder="e.g. Sam">
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
      : st.done ? `You scored ${st.total} of ${maxScore()} today.`
      : played ? `You're on question ${played + 1} of ${st.perDay}.`
      : `${st.perDay} new questions. ${st.answerMs / 1000} seconds and one answer for each.`;
    const btn = !st ? "" : st.done ? "See your results" : played ? "Continue" : "Play today's challenge";
    return `<section class="panel daily-card">
      <div class="daily-head">
        <div><p class="label">Daily challenge${st ? " · #" + st.day : ""}</p><h2>${esc(label)}</h2></div>
        <p class="mode-note">New questions in <span class="reset-in">${st ? untilReset() : "…"}</span></p>
      </div>
      ${tierLegend()}
      ${st && !st.done && !played ? `<div class="row"><input type="text" id="dnm" maxlength="18" value="${esc(savedName)}" placeholder="Your name for the leaderboard" aria-label="Your name"><button id="dplay">${btn}</button></div>`
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
            <p class="label">Today's leaderboard</p>
            <ol class="lb">${lb || `<li class="mode-note">No scores yet.</li>`}</ol>
          </section>
        </aside>
      </div>`;
    }
    return head + body;
  }

  async function dailyStart() {
    D.error = "";
    const el = document.getElementById("dnm");
    const name = (el ? el.value : savedName).trim() || savedName;
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

  render();
})();
