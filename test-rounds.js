// Checks the multiplayer round rules directly, with a fake clock and a small made-up question.
const assert = require("assert");
const G = require("./game");

const q = (text, answers) => ({ text, answers: answers.map(a => ({ display: a, tier: "refill", keys: [a.replace(/ /g, "")] })) });
const Q1 = q("Name a fruit", ["apple", "banana", "cherry", "date", "fig", "grape", "kiwi", "lemon", "mango", "orange"]);
const Q2 = q("Name a color", ["red", "blue", "green", "yellow", "purple", "black", "white", "pink"]);
let t = 1_000_000;
const cur = g => g.order[g.turn];

// ---- Wrong and repeated answers don't cost hearts or end the turn ----
let g = G.newGame(["A", "B", "C", "D"], Q1, t);
assert.strictEqual(cur(g), "A", "first round starts with the first player");
assert.deepStrictEqual(G.guess(g, "potato", t), { ok: false, why: "not on the list", text: "potato" });
assert.strictEqual(cur(g), "A", "a wrong answer keeps the turn");
assert.strictEqual(g.hearts.A, 3, "a wrong answer costs nothing");
assert.ok(G.guess(g, "apple", t).ok);
assert.strictEqual(cur(g), "B", "a correct answer passes the turn");
assert.strictEqual(G.guess(g, "apple", t).why, "already said", "repeats are rejected");
assert.strictEqual(cur(g), "B");
assert.strictEqual(g.turnEndsAt, t + G.TURN_MS, "a rejected answer doesn't reset the clock");

// ---- Timing out costs a heart and sits the player out ----
G.timeout(g, t);                       // B times out (1st loss)
assert.strictEqual(g.hearts.B, 2);
assert.deepStrictEqual(g.round.out, ["B"]);
assert.strictEqual(cur(g), "C");
G.guess(g, "banana", t);               // C
G.guess(g, "cherry", t);               // D
assert.strictEqual(cur(g), "A", "B is skipped while sitting out");
G.guess(g, "date", t);                 // A
assert.strictEqual(cur(g), "C", "B is still skipped");
G.timeout(g, t);                       // C times out (2nd loss): continue until it reaches A, the starter
assert.strictEqual(g.phase, "turn");
assert.strictEqual(cur(g), "D", "after the 2nd loss, play continues up to the starter");
G.guess(g, "fig", t);                  // D answers; next is A, the starter -> round over
assert.strictEqual(g.phase, "between", "round ends when the turn reaches the starter");
assert.strictEqual(g.lastRound.said.length, 5);
assert.ok(g.lastRound.missed.length > 0, "some unsaid answers are shown between rounds");

// ---- Next round: new question, everyone back in, starter rotates ----
G.startRound(g, Q2, t);
assert.strictEqual(g.round.question, Q2);
assert.deepStrictEqual(g.round.out, []);
assert.strictEqual(cur(g), "B", "the next player in order starts the next round");
assert.deepStrictEqual(g.hearts, { A: 3, B: 2, C: 2, D: 3 }, "hearts carry over");

// ---- If the 2nd loss happens right before the starter, the round ends at once ----
G.guess(g, "red", t);                  // B
G.timeout(g, t);                       // C (1st loss)
G.timeout(g, t);                       // D (2nd loss); next is A, then B (starter)
assert.strictEqual(g.phase, "turn");
assert.strictEqual(cur(g), "A");
G.guess(g, "blue", t);                 // A; next is B = starter
assert.strictEqual(g.phase, "between");

// ---- Losing the last heart knocks you out of the game; last one standing wins ----
g = G.newGame(["A", "B"], Q1, t);
g.hearts = { A: 1, B: 3 };
G.timeout(g, t);                       // A loses last heart
assert.strictEqual(g.status, "over");
assert.strictEqual(g.winner, "B", "the last surviving player wins");

// ---- Two players: once one sits out, the other's next correct answer ends the round ----
g = G.newGame(["A", "B"], Q1, t);
G.guess(g, "apple", t);                // A
G.timeout(g, t);                       // B (1st loss)
assert.strictEqual(cur(g), "A");
assert.strictEqual(G.guess(g, "potato", t).ok, false, "a wrong answer from the last player doesn't end the round");
assert.strictEqual(g.phase, "turn");
G.guess(g, "banana", t);               // A is the only one left and answers correctly
assert.strictEqual(g.phase, "between", "one correct answer from the last player ends the round");
assert.deepStrictEqual(g.hearts, { A: 3, B: 2 });
G.startRound(g, Q2, t);
assert.strictEqual(cur(g), "B", "B starts round 2");

// ---- The last player in the round can also time out instead ----
g = G.newGame(["A", "B"], Q1, t);
G.timeout(g, t);                       // A (1st loss)
G.timeout(g, t);                       // B (2nd loss)
assert.strictEqual(g.phase, "between", "round ends when nobody is left in it");

// ---- Three players: the rule kicks in only when one is left, not two ----
g = G.newGame(["A", "B", "C"], Q1, t);
G.timeout(g, t);                       // A sits out; B and C still in
G.guess(g, "apple", t);                // B
assert.strictEqual(g.phase, "turn", "two players still in: the round goes on");
assert.strictEqual(cur(g), "C");
G.timeout(g, t);                       // C sits out (2nd loss); only B left, and the starter A is next
assert.strictEqual(g.phase, "between");
g = G.newGame(["A", "B", "C"], Q1, t);
g.hearts.C = 0;                        // C already out of the game
G.timeout(g, t);                       // A sits out, B is the only one left
assert.strictEqual(cur(g), "B");
G.guess(g, "fig", t);
assert.strictEqual(g.phase, "between", "players out of the game don't count as still in the round");

// ---- Solo games keep going on the same question ----
g = G.newGame(["A"], Q1, t);
G.guess(g, "apple", t);
assert.strictEqual(g.phase, "turn", "solo: a correct answer doesn't end the round");

// ---- Eliminated players are skipped as starters and in turn order ----
g = G.newGame(["A", "B", "C"], Q1, t);
g.hearts.B = 0;
G.guess(g, "apple", t);
assert.strictEqual(cur(g), "C", "players with no hearts never get a turn");
g.phase = "between";
G.startRound(g, Q2, t);
assert.strictEqual(cur(g), "C", "the starter skips players with no hearts");

// ---- Solo game ends when the player runs out of hearts ----
g = G.newGame(["A"], Q1, t);
for (let i = 0; i < 3; i++) { G.timeout(g, t); if (g.phase === "between") G.startRound(g, Q2, t); }
assert.strictEqual(g.status, "over");
assert.strictEqual(g.winner, null);

// ---- Leaving mid-game ----
g = G.newGame(["A", "B", "C"], Q1, t);
G.knockOut(g, "A", t);
assert.strictEqual(cur(g), "B", "if the current player leaves, the turn moves on");
G.knockOut(g, "C", t);
assert.strictEqual(g.status, "over");
assert.strictEqual(g.winner, "B");

console.log("Round rule checks passed.");
