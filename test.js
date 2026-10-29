// End-to-end check: starts the server, connects two players, and plays a short game over the network.
// Run with: npm test
process.env.PORT = process.env.PORT || "3999";
process.env.TURN_SECONDS = "2";
process.env.ROUND_PAUSE_SECONDS = "1";
const assert = require("assert");
const { io } = require("socket.io-client");
const { loadQuestions } = require("./daily");
const { server } = require("./server");

const URL = `http://localhost:${process.env.PORT}`;
const QUESTIONS = loadQuestions();
const wait = ms => new Promise(r => setTimeout(r, ms));
const call = (s, ev, data = {}) => new Promise(r => s.emit(ev, data, r));

function player(token) {
  const s = io(URL, { forceNew: true });
  s.latest = null;
  s.on("state", st => { s.latest = st; });
  return new Promise(r => s.on("connect", async () => { s.you = (await call(s, "hello", { token })).you; r(s); }));
}
// An answer to the current question that hasn't been said yet this round.
function freshAnswer(st) {
  const q = QUESTIONS.find(x => x.text === st.game.round.question);
  const said = new Set(st.game.round.said.map(s => s.text));
  return q.answers.find(a => !said.has(a.display)).display;
}

(async () => {
  const a = await player("alice-token-0123456789");
  const b = await player("bob-token-0123456789ab");

  const created = await call(a, "create", { name: "Alice" });
  assert.ok(created.ok, "create room");
  const code = created.code;
  assert.ok((await call(b, "join", { code, name: "Bob" })).ok, "join room");
  assert.strictEqual((await call(b, "join", { code: "QQQQ", name: "Bob" })).ok, false, "bad code is refused");
  assert.strictEqual((await call(b, "start")).ok, false, "only the host can start");
  assert.ok((await call(a, "start")).ok, "host starts");
  await wait(100);
  let st = a.latest;
  assert.strictEqual(st.status, "playing");
  assert.strictEqual(st.game.phase, "turn");
  assert.ok(st.game.round.question.startsWith("Name"), "round shows a question");
  const q = QUESTIONS.find(x => x.text === st.game.round.question);
  assert.ok(!JSON.stringify(st).includes(q.answers[q.answers.length - 1].display) || q.answers.length < 3, "answer list is not sent");
  assert.deepStrictEqual(st.game.hearts, { [a.you]: 3, [b.you]: 3 });

  // Alice's turn. Bob can't answer; Alice's wrong answer doesn't cost anything.
  assert.strictEqual((await call(b, "guess", { text: "anything" })).ok, false, "out-of-turn answer refused");
  const wrong = await call(a, "guess", { text: "zzzz definitely not an answer" });
  assert.strictEqual(wrong.result.why, "not on the list");
  await wait(50);
  assert.strictEqual(a.latest.game.order[a.latest.game.turn], a.you, "still Alice's turn after a wrong answer");
  assert.strictEqual(a.latest.game.hearts[a.you], 3);

  const ans = freshAnswer(a.latest);
  assert.ok((await call(a, "guess", { text: ans })).result.ok, "correct answer accepted");
  await wait(50);
  st = a.latest;
  assert.strictEqual(st.game.order[st.game.turn], b.you, "turn passes to Bob");
  assert.strictEqual((await call(b, "guess", { text: ans })).result.why, "already said", "repeats are rejected");

  // Bob runs out of time: loses a heart and sits out. Alice plays on alone, then times out too.
  await wait(2500);
  st = a.latest;
  assert.strictEqual(st.game.hearts[b.you], 2, "timeout costs a heart");
  assert.ok(st.game.round.out.includes(b.you), "Bob sits out the rest of the round");
  assert.strictEqual(st.game.order[st.game.turn], a.you);
  await call(a, "guess", { text: freshAnswer(st) });
  await wait(50);
  assert.strictEqual(a.latest.game.order[a.latest.game.turn], a.you, "Alice keeps answering alone");
  await wait(2500);
  st = a.latest;
  assert.strictEqual(st.game.hearts[a.you], 2);
  assert.strictEqual(st.game.phase, "between", "round ends after the 2nd heart is lost");
  assert.ok(st.game.lastRound.said.length === 2 && st.game.lastRound.missed.length > 0);

  // Next round: new question, Bob starts, everyone back in.
  await wait(1200);
  st = a.latest;
  assert.strictEqual(st.game.phase, "turn");
  assert.strictEqual(st.game.roundNo, 2);
  assert.notStrictEqual(st.game.round.question, q.text, "a new question");
  assert.strictEqual(st.game.order[st.game.turn], b.you, "the next player starts the next round");
  assert.deepStrictEqual(st.game.round.out, []);

  // Play it out: both keep timing out until Bob has no hearts left.
  for (let i = 0; i < 20 && a.latest.status === "playing"; i++) await wait(500);
  st = a.latest;
  assert.strictEqual(st.status, "over", "game ends");
  assert.ok(st.game.winner, "someone wins");
  assert.strictEqual(st.game.hearts[st.game.winner] > 0, true);

  assert.ok((await call(a, "lobby")).ok, "host returns to lobby");
  await wait(100);
  assert.strictEqual(b.latest.status, "lobby");

  // Reconnect keeps your seat.
  b.disconnect();
  await wait(100);
  const b2 = await player("bob-token-0123456789ab");
  assert.ok((await call(b2, "join", { code, name: "Bob" })).ok);
  await wait(100);
  assert.strictEqual(a.latest.players.length, 2, "rejoining does not duplicate a player");
  assert.ok(a.latest.players.every(p => p.connected));

  console.log("Multiplayer checks passed.");
  a.close(); b2.close(); server.close();
  process.exit(0);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
