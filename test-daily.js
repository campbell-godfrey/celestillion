// Checks the daily challenge rules with a fake clock: scoring, the 25-second limit,
// one play per day, the leaderboard, the 00:00 UTC reset, and saving to disk.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("./daily");

const questions = D.loadQuestions();
assert.strictEqual(questions.length % D.PER_DAY, 0, "question count is a multiple of 5");
for (const q of questions) {
  const tiers = new Set(q.answers.map(a => a.tier));
  assert.strictEqual(tiers.size, 5, `"${q.text}" has all five tiers`);
}

// Matching
const moons = questions.find(q => q.text.startsWith("Name a moon"));
assert.strictEqual(D.matchAnswer(moons, "The Moon").tier, "refill");
assert.strictEqual(D.matchAnswer(moons, "Ganymede").tier, "pufferfish");
assert.strictEqual(D.matchAnswer(moons, "ganymeed").tier, "pufferfish", "one typo is forgiven on longer answers");
assert.strictEqual(D.matchAnswer(moons, "Kerberos").tier, "celestillion");
assert.strictEqual(D.matchAnswer(moons, "Pluto"), null, "wrong answers score nothing");
const langs = questions.find(q => q.text.startsWith("Name a programming"));
assert.strictEqual(D.matchAnswer(langs, "C").display, "c");
assert.strictEqual(D.matchAnswer(langs, "C++").display, "c++");
assert.strictEqual(D.matchAnswer(langs, "c#").display, "c#");
const painters = questions.find(q => q.text.startsWith("Name a famous painter"));
assert.strictEqual(D.matchAnswer(painters, "Salvador Dalí").tier, "spinner", "accents are ignored");
const heroes = questions.find(q => q.text.startsWith("Name a superhero"));
assert.strictEqual(D.matchAnswer(heroes, "Spider Man").tier, "refill", "spacing is ignored");

// Optional answer images
{
  const tmp = path.join(os.tmpdir(), `daily-img-${process.pid}.txt`);
  fs.writeFileSync(tmp, [
    "? Name a moon",
    "refill: moon|the moon{https://example.com/moon.jpg?w=400,h=300}, luna two",
    "spinner: titan{https://example.com/titan.png}, europa",
    "pufferfish: io", "seeker: triton", "celestillion: kerberos{https://example.com/k.jpg}",
  ].join("\n"));
  const [mq] = D.loadQuestions(tmp);
  assert.strictEqual(mq.answers.length, 7, "a comma inside an image link doesn't split the list");
  assert.strictEqual(D.matchAnswer(mq, "the moon").image, "https://example.com/moon.jpg?w=400,h=300", "image belongs to the answer and its alternates");
  assert.strictEqual(D.matchAnswer(mq, "Titan").image, "https://example.com/titan.png");
  assert.strictEqual(D.matchAnswer(mq, "europa").image, null, "answers without an image have none");
  assert.strictEqual(D.matchAnswer(mq, "kerberos").display, "kerberos", "the link isn't part of the answer text");
  fs.writeFileSync(tmp, "? Q\nrefill: a{javascript:alert(1)}\nspinner: b\npufferfish: c\nseeker: d\ncelestillion: e");
  assert.throws(() => D.loadQuestions(tmp), /usable image link/, "only http(s) links are allowed");
  fs.writeFileSync(tmp, "? Q\nrefill: a{https://x.com/a b.jpg}");
  assert.throws(() => D.loadQuestions(tmp), /usable image link/, "links with spaces are refused");
  fs.rmSync(tmp);
}

// Day rotation and reset
const day1 = Date.UTC(2026, 9, 29, 12, 0, 0);
assert.strictEqual(D.dayNumber(day1), 1);
assert.strictEqual(D.dayNumber(Date.UTC(2026, 9, 29, 23, 59, 59)), 1);
assert.strictEqual(D.dayNumber(Date.UTC(2026, 9, 30, 0, 0, 0)), 2, "resets at 00:00 UTC");
assert.strictEqual(D.resetsAt(day1), Date.UTC(2026, 9, 30));
const q1 = D.questionsFor(questions, day1).map(q => q.text);
const q2 = D.questionsFor(questions, day1 + D.DAY_MS).map(q => q.text);
assert.strictEqual(new Set([...q1, ...q2]).size, 10, "each day gets 5 new questions");
const loop = D.questionsFor(questions, day1 + (questions.length / D.PER_DAY) * D.DAY_MS).map(q => q.text);
assert.deepStrictEqual(loop, q1, "the list loops after the last day");

// A full run with a fake clock
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-"));
let t = day1;
const store = D.createStore(dir);
const daily = D.createDaily({ questions, store, now: () => t });
const today = D.questionsFor(questions, t);
const answerFor = (q, tier) => q.answers.find(a => a.tier === tier).display;

let st = daily.status("alice");
assert.strictEqual(st.results.length, 0);
assert.ok(!st.current, "looking at the page doesn't start the clock");

st = daily.next("alice", "Alice");
assert.strictEqual(st.current.question, today[0].text);
assert.ok(!JSON.stringify(st).includes(answerFor(today[0], "celestillion")), "answers are never sent to the browser");
t += 5000;
st = daily.answer("alice", answerFor(today[0], "celestillion"));
assert.deepStrictEqual([st.last.tier, st.last.points], ["celestillion", 100]);
st = daily.answer("alice", answerFor(today[0], "refill"));
assert.ok(st.error, "only one answer per question");
assert.strictEqual(st.total, 100);

daily.next("alice");
t += 5000;
st = daily.answer("alice", answerFor(today[1], "pufferfish"));
assert.strictEqual(st.last.points, 60);

daily.next("alice");
t += 3000;
st = daily.next("alice");
assert.strictEqual(st.current.deadline, t - 3000 + D.ANSWER_MS, "refreshing doesn't restart the clock");
t += D.ANSWER_MS + 5000;
st = daily.status("alice");
assert.strictEqual(st.results[2].points, 0, "running out of time scores 0");
assert.ok(st.results[2].timedOut);

daily.next("alice");
st = daily.answer("alice", "definitely not an answer");
assert.strictEqual(st.last.points, 0);
daily.next("alice");
st = daily.answer("alice", "");
assert.strictEqual(st.last.points, 0, "a blank answer scores 0");
assert.ok(st.done);
assert.strictEqual(st.total, 160);
assert.strictEqual(st.rank, 1);

st = daily.next("alice");
assert.ok(st.done && !st.current, "one play per day");

daily.next("bob", "Bob");
daily.answer("bob", answerFor(today[0], "celestillion"));
for (let i = 1; i < 5; i++) { daily.next("bob"); daily.answer("bob", answerFor(today[i], "celestillion")); }
st = daily.status("bob");
assert.strictEqual(st.total, 500);
assert.deepStrictEqual(st.leaderboard.map(e => [e.name, e.score]), [["Bob", 500], ["Alice", 160]]);

// Saved to disk and reloaded after a restart
daily.flush();
const reloaded = D.createDaily({ questions, store: D.createStore(dir), now: () => t });
assert.strictEqual(reloaded.status("alice").total, 160, "results survive a restart");
assert.strictEqual(reloaded.leaderboard().length, 2);

// Next UTC day: a fresh challenge
t = Date.UTC(2026, 9, 30, 0, 0, 5);
st = reloaded.status("alice");
assert.strictEqual(st.day, 2);
assert.strictEqual(st.results.length, 0);
assert.strictEqual(st.leaderboard.length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log("Daily checks passed.");
