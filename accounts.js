// Optional accounts for Celestillion: username + password, or Discord.
// Accounts keep a history of daily scores (for the top 5) and a friends list.
// Nobody needs an account to play.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const USERNAME_RE = /^[a-z0-9_.-]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_FRIENDS = 200;

const cleanDisplay = n => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 18);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const want = Buffer.from(hash, "hex");
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}

function createAccounts(dir = process.env.DATA_DIR || path.join(__dirname, "data")) {
  const file = path.join(dir, "accounts.json");
  let data = { users: {}, sessions: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  data.users ||= {}; data.sessions ||= {};

  let timer = null;
  function writeNow() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(data));
      fs.renameSync(file + ".tmp", file);
    } catch (e) { console.error("Could not save accounts:", e.message); }
  }
  function save() { clearTimeout(timer); timer = setTimeout(writeNow, 200); }
  function flush() { clearTimeout(timer); writeNow(); }

  const byUsername = name => {
    const lower = String(name ?? "").trim().toLowerCase();
    return Object.values(data.users).find(u => u.username === lower) || null;
  };
  const byDiscord = did => Object.values(data.users).find(u => u.discordId === did) || null;
  const newId = () => { let id; do { id = crypto.randomBytes(6).toString("hex"); } while (data.users[id]); return id; };

  function blankUser(fields) {
    return { id: newId(), createdAt: Date.now(), displayName: fields.username, passwordHash: null, discordId: null, discordName: null,
             scores: [], friends: [], incoming: [], outgoing: [], ...fields };
  }

  /** What the browser is allowed to see about the signed-in user. */
  function publicUser(u) {
    if (!u) return null;
    const top = [...u.scores].sort((a, b) => b.score - a.score || a.day - b.day).slice(0, 5);
    const brief = id => { const f = data.users[id]; return f && { id: f.id, username: f.username, displayName: f.displayName }; };
    return {
      id: u.id, username: u.username, displayName: u.displayName, hasPassword: !!u.passwordHash,
      discord: u.discordId ? { name: u.discordName } : null,
      topScores: top, gamesPlayed: u.scores.length,
      friends: u.friends.map(brief).filter(Boolean),
      incoming: u.incoming.map(brief).filter(Boolean),
      outgoing: u.outgoing.map(brief).filter(Boolean),
    };
  }

  function validUsername(name) {
    const lower = String(name ?? "").trim().toLowerCase();
    if (!USERNAME_RE.test(lower)) throw new Error("Usernames are 3–20 characters: letters, numbers, dots, dashes or underscores.");
    return lower;
  }

  return {
    flush, publicUser,
    get: id => data.users[id] || null,

    register(username, password) {
      const name = validUsername(username);
      if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
      if (password.length > 200) throw new Error("That password is too long.");
      if (byUsername(name)) throw new Error("That username is taken. Try another.");
      const u = blankUser({ username: name, displayName: String(username).trim().slice(0, 18), passwordHash: hashPassword(password) });
      data.users[u.id] = u; save();
      return u;
    },

    login(username, password) {
      const u = byUsername(username);
      // Same message either way, so the form doesn't reveal which usernames exist.
      if (!u || !u.passwordHash || !checkPassword(String(password ?? ""), u.passwordHash)) throw new Error("Wrong username or password.");
      return u;
    },

    /** Finds or creates the account for a Discord user. If linkTo is set, attaches Discord to that account instead. */
    discordLogin(discordUser, linkTo = null) {
      const did = String(discordUser.id);
      const shown = discordUser.global_name || discordUser.username || "Player";
      const existing = byDiscord(did);
      if (linkTo) {
        const me = data.users[linkTo];
        if (!me) throw new Error("Log in again, then connect Discord.");
        if (existing && existing.id !== me.id) throw new Error("That Discord account is already used by another Celestillion account.");
        me.discordId = did; me.discordName = discordUser.username; save();
        return me;
      }
      if (existing) { existing.discordName = discordUser.username; save(); return existing; }
      // New account: base the username on the Discord username, adding numbers if it's taken.
      let base = String(discordUser.username || "player").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 16);
      if (base.length < 3) base = "player";
      let name = base, n = 1;
      while (byUsername(name)) name = `${base}${++n}`.slice(0, 20);
      const u = blankUser({ username: name, displayName: cleanDisplay(shown) || name, discordId: did, discordName: discordUser.username });
      data.users[u.id] = u; save();
      return u;
    },

    unlinkDiscord(id) {
      const u = data.users[id];
      if (!u.passwordHash) throw new Error("Set a password first, or you'd have no way to log in.");
      u.discordId = null; u.discordName = null; save();
      return u;
    },

    setPassword(id, current, next) {
      const u = data.users[id];
      if (u.passwordHash && !checkPassword(String(current ?? ""), u.passwordHash)) throw new Error("Your current password is wrong.");
      if (typeof next !== "string" || next.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
      u.passwordHash = hashPassword(next); save();
      return u;
    },

    setDisplayName(id, name) {
      const clean = cleanDisplay(name);
      if (!clean) throw new Error("Display names can't be empty.");
      data.users[id].displayName = clean; save();
      return data.users[id];
    },

    /** Keeps the best score for each day the account played the daily challenge. */
    recordScore(id, day, score) {
      const u = data.users[id];
      if (!u) return;
      const prev = u.scores.find(s => s.day === day);
      if (prev) prev.score = Math.max(prev.score, score); else u.scores.push({ day, score });
      save();
    },

    /* ---------- Friends ---------- */
    requestFriend(id, username) {
      const me = data.users[id], them = byUsername(username);
      if (!them) throw new Error(`No player is called "${String(username).trim()}".`);
      if (them.id === me.id) throw new Error("You can't add yourself.");
      if (me.friends.includes(them.id)) throw new Error(`You're already friends with ${them.displayName}.`);
      if (me.friends.length >= MAX_FRIENDS) throw new Error(`You can have up to ${MAX_FRIENDS} friends.`);
      // If they already asked you, this accepts.
      if (me.incoming.includes(them.id)) return this.acceptFriend(id, them.id);
      if (!me.outgoing.includes(them.id)) { me.outgoing.push(them.id); them.incoming.push(me.id); save(); }
      return me;
    },
    acceptFriend(id, otherId) {
      const me = data.users[id], them = data.users[otherId];
      if (!them || !me.incoming.includes(otherId)) throw new Error("That friend request is no longer there.");
      me.incoming = me.incoming.filter(x => x !== otherId);
      them.outgoing = them.outgoing.filter(x => x !== id);
      if (!me.friends.includes(otherId)) me.friends.push(otherId);
      if (!them.friends.includes(id)) them.friends.push(id);
      save();
      return me;
    },
    /** Declines a request, cancels one you sent, or removes a friend. */
    dropFriend(id, otherId) {
      const me = data.users[id], them = data.users[otherId];
      me.incoming = me.incoming.filter(x => x !== otherId);
      me.outgoing = me.outgoing.filter(x => x !== otherId);
      me.friends = me.friends.filter(x => x !== otherId);
      if (them) {
        them.incoming = them.incoming.filter(x => x !== id);
        them.outgoing = them.outgoing.filter(x => x !== id);
        them.friends = them.friends.filter(x => x !== id);
      }
      save();
      return me;
    },
    friendIds: id => data.users[id]?.friends ?? [],

    /* ---------- Sessions ---------- */
    createSession(userId) {
      const token = crypto.randomBytes(32).toString("base64url");
      data.sessions[sha(token)] = { userId, expires: Date.now() + SESSION_MS };
      save();
      return token;
    },
    userForSession(token) {
      if (!token) return null;
      const s = data.sessions[sha(token)];
      if (!s) return null;
      if (s.expires < Date.now()) { delete data.sessions[sha(token)]; save(); return null; }
      return data.users[s.userId] || null;
    },
    endSession(token) { if (token) { delete data.sessions[sha(token)]; save(); } },
    pruneSessions() {
      const now = Date.now();
      for (const [k, s] of Object.entries(data.sessions)) if (s.expires < now) delete data.sessions[k];
      save();
    },
  };
}

/* ---------- Small helpers for the web server ---------- */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Counts attempts per key in a sliding window, for slowing down password guessing. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return list.length <= max;
  };
}

module.exports = { createAccounts, parseCookies, rateLimiter, SESSION_MS, hashPassword, checkPassword };
