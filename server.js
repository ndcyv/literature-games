// The Literature Games: a live classroom quiz.
//   /host   projector screen (password)   /admin  plans and questions (password)   /  students
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const E = require("./engine");
const store = require("./store")();

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || "literature";
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- data ----------
let GAMES = {}, PLANS = [];
const media = new Map();
async function loadData() {
  const games = {};
  for (const f of (await store.list("games")).filter((f) => f.endsWith(".json"))) {
    try { const g = JSON.parse((await store.read(`games/${f}`)).toString("utf8")); games[g.id] = g; } catch (e) { console.error("Bad game file", f, e.message); }
  }
  GAMES = games;
  const p = await store.read("plans.json");
  PLANS = p ? JSON.parse(p.toString("utf8")).plans || [] : [];
  console.log(`Loaded ${Object.keys(GAMES).length} games and ${PLANS.length} day plans from ${store.describe}`);
}
const sortedGames = () => Object.values(GAMES).sort((a, b) => (a.order || 99) - (b.order || 99));
const playableIdx = (g) => g.questions.map((q, i) => (E.playable(g.type, q) ? i : -1)).filter((i) => i >= 0);

// ---------- rooms ----------
const rooms = new Map();
const newCode = () => {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ"; let c;
  do c = Array.from({ length: 4 }, () => L[crypto.randomInt(L.length)]).join(""); while (rooms.has(c));
  return c;
};
const key = (r) => `${r.gi}:${r.qi}`;
const item = (r) => r.items[r.gi];
const curQ = (r) => { const it = item(r); return it && r.qi >= 0 ? it.game.questions[it.qs[r.qi]] : null; };
const limitMs = (r) => item(r).game.timeLimit * 1000;
const players = (r) => [...r.players.values()];
const online = (r) => players(r).filter((p) => p.connected);
const totalOf = (r, pid, gi) => Object.entries(r.res).reduce((s, [k, res]) => s + ((gi == null || k.startsWith(gi + ":")) ? (res.points[pid] || 0) : 0), 0);
const board = (r, gi) => players(r).map((p) => ({ id: p.id, name: p.name, score: totalOf(r, p.id, gi) })).sort((a, b) => b.score - a.score);

function buildItems(planId, gameId) {
  const entries = planId ? (PLANS.find((p) => p.id === planId)?.games || []) : [{ game: gameId }];
  return entries.map((e) => {
    const g = GAMES[e.game]; if (!g) return null;
    const ok = new Set(playableIdx(g));
    const qs = (e.questions && e.questions.length ? e.questions : [...ok]).filter((i) => ok.has(i));
    return qs.length ? { game: JSON.parse(JSON.stringify(g)), qs } : null;
  }).filter(Boolean);
}

// fixed pairs for Close Call; late joiners join the smallest group
function ensurePairs(r) {
  const gi = r.gi; const ids = online(r).map((p) => p.id);
  if (!r.pairs[gi]) {
    const s = [...ids].sort(() => Math.random() - 0.5); const groups = [];
    for (let i = 0; i < s.length; i += 2) groups.push(s.slice(i, i + 2));
    if (groups.length > 1 && groups[groups.length - 1].length === 1) groups[groups.length - 2].push(groups.pop()[0]);
    r.pairs[gi] = groups;
  }
  for (const id of ids) if (!r.pairs[gi].some((g) => g.includes(id))) {
    const g = [...r.pairs[gi]].sort((a, b) => a.length - b.length)[0];
    if (g && g.length < 2) g.push(id); else r.pairs[gi].push([id]);
  }
}
// roles for Hint Hijack rotate through the players
function makeRoles(r) {
  const ids = online(r).map((p) => p.id); const n = ids.length; if (n < 2) return {};
  const k = ((r.rot[r.gi] = (r.rot[r.gi] ?? -1) + 1) * 2) % n;
  const at = (i) => ids[(k + i) % n];
  return { giver: at(0), guesser: at(1), blockers: n >= 4 ? [at(2), at(3)] : n === 3 ? [at(2)] : [] };
}

function rescore(r, k = key(r)) {
  const [gi, qi] = k.split(":").map(Number);
  const it = r.items[gi]; const q = it.game.questions[it.qs[qi]];
  r.res[k] = E.score(it.game.type, q, r.ans[k] || {}, { accepted: r.accepted[k] || {}, limitMs: it.game.timeLimit * 1000, pairs: r.pairs[gi], roles: r.roles[k] });
}

function setTimers(r) {
  clearTimeout(r.timer); clearTimeout(r.stageTimer);
  const type = item(r).game.type, q = curQ(r), L = limitMs(r);
  if (type === "hint") { r.timer = setTimeout(() => (r.stage === 0 ? hintGuessStage(r) : reveal(r)), r.deadline - Date.now() + 300); return; }
  r.timer = setTimeout(() => reveal(r), r.deadline - Date.now() + 300);
  const K = E.TYPES[type].stages?.(q) || 0;
  if (K > 1 && r.stage < K - 1) {
    const step = type === "posh" ? L / 2 : L / K;
    r.stageTimer = setTimeout(() => { if (r.phase === "question") { r.stage++; setTimers(r); broadcast(r); } }, Math.max(500, r.started + step * (r.stage + 1) - Date.now()));
  }
}
function hintGuessStage(r) {
  if (r.phase !== "question" || r.stage !== 0) return;
  r.stage = 1; r.started = Date.now(); r.deadline = r.started + limitMs(r); setTimers(r); broadcast(r);
}

function ask(r, qi) {
  r.qi = qi; r.phase = "question"; r.stage = 0; r.started = Date.now(); r.deadline = r.started + limitMs(r);
  const k = key(r); r.ans[k] = {};
  const type = item(r).game.type;
  if (type === "closest") ensurePairs(r);
  if (type === "hint") r.roles[k] = makeRoles(r);
  setTimers(r); broadcast(r);
}
function reveal(r) {
  if (r.phase !== "question") return;
  clearTimeout(r.timer); clearTimeout(r.stageTimer);
  r.phase = "revealed"; rescore(r); broadcast(r);
}
function next(r) {
  if (r.phase === "lobby") { r.gi = 0; r.qi = -1; r.phase = "intro"; }
  else if (r.phase === "intro") return ask(r, 0);
  else if (r.phase === "revealed") { if (r.qi + 1 < item(r).qs.length) return ask(r, r.qi + 1); r.phase = "gameover"; }
  else if (r.phase === "gameover") { if (r.gi + 1 < r.items.length) { r.gi++; r.qi = -1; r.phase = "intro"; } else r.phase = "final"; }
  broadcast(r);
}
function everyoneDone(r) {
  const k = key(r), a = r.ans[k], type = item(r).game.type, on = online(r);
  if (type === "hint") {
    const ro = r.roles[k] || {};
    if (r.stage === 0) return [ro.giver, ...(ro.blockers || [])].filter(Boolean).every((id) => a[id]?.clues || !r.players.get(id)?.connected);
    return on.filter((p) => p.id !== ro.giver && !(ro.blockers || []).includes(p.id)).every((p) => a[p.id]?.value !== undefined);
  }
  return on.length > 0 && on.every((p) => a[p.id]);
}

// ---------- what each screen sees ----------
const nameOf = (r, id) => r.players.get(id)?.name || "?";
function groupsFor(r, k, type, q, res) {
  const out = {};
  for (const [pid, a] of Object.entries(r.ans[k] || {})) {
    if (type === "hint" && a.value === undefined) continue;
    let gkey, text;
    if (type === "pairs") { gkey = (a.value || []).map(E.norm).join("|"); text = (a.value || []).join(" / "); }
    else if (type === "order") { gkey = (a.value || []).join(","); text = (a.value || []).map((i) => i + 1).join(" – "); }
    else { gkey = E.norm(a.value); text = String(a.value ?? ""); }
    if (!gkey || /^\|*$/.test(gkey)) { gkey = "(blank)"; text = "(no answer)"; }
    out[gkey] ??= { key: gkey, text, names: [], correct: false };
    out[gkey].names.push(nameOf(r, pid)); if (res.correct[pid]) out[gkey].correct = true;
    if (type === "unique") out[gkey].valid = res.valid?.has(gkey);
  }
  return Object.values(out).sort((a, b) => b.correct - a.correct || b.names.length - a.names.length);
}

function hostState(r) {
  const s = { code: r.code, phase: r.phase, title: r.title, joinUrl: r.joinUrl, qr: r.qr,
    games: r.items.map((it) => it.game.title), gi: r.gi, qi: r.qi,
    players: players(r).map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    leaderboard: board(r), gameBoard: r.gi >= 0 && r.items[r.gi] ? board(r, r.gi) : [] };
  const it = item(r);
  if (it) s.game = { id: it.game.id, type: it.game.type, title: it.game.title, intro: it.game.intro, count: it.qs.length, timeLimit: it.game.timeLimit, index: r.gi };
  if (r.phase === "question" || r.phase === "revealed") {
    const q = curQ(r), k = key(r), type = it.game.type;
    s.question = E.publicQuestion(type, q, r.phase === "revealed" ? 99 : r.stage);
    s.stage = r.stage; s.deadline = r.deadline; s.started = r.started; s.stages = E.TYPES[type].stages?.(q) || 0;
    const a = r.ans[k] || {};
    s.players.forEach((p) => (p.answered = type === "hint" ? (r.stage === 0 ? !!a[p.id]?.clues : a[p.id]?.value !== undefined) : !!a[p.id]));
    if (type === "hint") {
      const ro = r.roles[k] || {};
      s.roles = { giver: nameOf(r, ro.giver), guesser: nameOf(r, ro.guesser), blockers: (ro.blockers || []).map((b) => nameOf(r, b)) };
      if (r.stage >= 1) s.question.clues = a[ro.giver]?.clues || [];
    }
    if (type === "closest" && r.pairs[r.gi]) s.pairs = r.pairs[r.gi].map((g) => g.map((id) => nameOf(r, id)));
    if (r.phase === "revealed") {
      const res = r.res[k];
      s.answer = E.answerText(type, q); s.groups = groupsFor(r, k, type, q, res);
      const ro = r.roles[k] || {};
      s.missing = online(r).filter((p) => !a[p.id]?.value && a[p.id]?.value !== 0 && !(type === "hint" && [ro.giver, ...(ro.blockers || [])].includes(p.id))).map((p) => p.name);
      if (type === "order") s.orderAnswer = q.items.map((x, i) => ({ label: x.label, year: x.year, n: i + 1 })).sort((x, y) => x.year - y.year);
      if (type === "choice") { s.counts = {}; for (const v of Object.values(a)) s.counts[v.value] = (s.counts[v.value] || 0) + 1; s.question.answerMarker = Number(q.answer); }
      if (type === "closest") s.pairResults = (res.pairs || []).map((p) => ({ names: p.members.map((id) => nameOf(r, id)), guesses: p.members.map((id) => a[id]?.value ?? "–"), avg: Math.round(p.avg * 100) / 100, dist: Math.round(p.dist * 100) / 100, win: !!res.correct[p.members[0]] })).sort((x, y) => x.dist - y.dist);
      if (type === "hint") s.hint = { clues: res.clues, blocks: Object.entries(res.blocks).map(([b, w]) => ({ name: nameOf(r, b), words: a[b]?.clues || [], matched: w })), blocked: res.blocked, guess: res.guess };
      if (type === "unique") s.validCount = q.answers.length;
    }
  }
  return s;
}

function playerState(r, p) {
  const rows = board(r); const rank = rows.findIndex((x) => x.id === p.id) + 1;
  const s = { phase: r.phase, name: p.name, score: totalOf(r, p.id), rank, total: rows.length, title: r.title };
  const it = item(r);
  if (it) s.game = { title: it.game.title, intro: it.game.intro, type: it.game.type, count: it.qs.length, timeLimit: it.game.timeLimit };
  if (r.phase === "gameover") s.gameScore = totalOf(r, p.id, r.gi);
  if (r.phase === "question" || r.phase === "revealed") {
    const q = curQ(r), k = key(r), type = it.game.type, a = r.ans[k]?.[p.id];
    s.qi = r.qi; s.deadline = r.deadline; s.stage = r.stage;
    s.question = E.publicQuestion(type, q, r.phase === "revealed" ? 99 : r.stage);
    s.mine = a ? { value: a.value, clues: a.clues } : null;
    if (type === "hint") {
      const ro = r.roles[k] || {};
      s.role = p.id === ro.giver ? "giver" : p.id === ro.guesser ? "guesser" : (ro.blockers || []).includes(p.id) ? "blocker" : "watcher";
      s.partner = s.role === "giver" ? nameOf(r, ro.guesser) : s.role === "guesser" ? nameOf(r, ro.giver) : null;
      if ((s.role === "giver" || s.role === "blocker") && r.stage === 0) s.card = q.answer;
      if (r.stage >= 1) s.question.clues = r.ans[k]?.[ro.giver]?.clues || [];
    }
    if (type === "closest" && r.pairs[r.gi]) { const g = r.pairs[r.gi].find((x) => x.includes(p.id)) || []; s.partners = g.filter((id) => id !== p.id).map((id) => nameOf(r, id)); }
    if (r.phase === "revealed") {
      const res = r.res[k]; s.answer = E.answerText(type, q); s.correct = !!res.correct[p.id]; s.gained = res.points[p.id] || 0;
      if (type === "order") s.answer = [...q.items].sort((x, y) => x.year - y.year).map((x) => `${x.label} (${x.year < 0 ? -x.year + " BC" : x.year})`).join("  →  ");
      if (type === "closest") { const row = (res.pairs || []).find((x) => x.members.includes(p.id)); if (row) s.note = `Your pair’s average: ${Math.round(row.avg * 100) / 100}`; }
      if (type === "unique") { s.answer = "Any correct answer that nobody else gave"; if (a && !res.correct[p.id] && res.valid?.has(E.norm(a.value))) s.note = "Correct, but someone else wrote it too!"; }
      if (type === "posh" && res.correct[p.id] && a?.stage === 0) s.note = "You answered the posh question: double points!";
      if (type === "hint" && res.blocked && (s.role === "giver" || s.role === "guesser")) s.note = "Your clues were blocked!";
      if (type === "hint" && s.role === "blocker" && res.correct[p.id]) s.note = "You blocked a clue!";
    }
  }
  return s;
}

function broadcast(r) {
  if (r.hostSocket) io.to(r.hostSocket).emit("host:state", hostState(r));
  for (const p of r.players.values()) if (p.socket) io.to(p.socket).emit("player:state", playerState(r, p));
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  socket.on("host:list", ({ password }, cb) => {
    if (password !== PASSWORD) return cb?.({ error: "Wrong password" });
    cb?.({ plans: PLANS.map((p) => ({ id: p.id, name: p.name, games: (p.games || []).map((e) => GAMES[e.game]?.title).filter(Boolean) })),
      games: sortedGames().map((g) => ({ id: g.id, title: g.title, count: playableIdx(g).length })) });
  });
  socket.on("host:create", async ({ password, planId, gameId, hostKey }, cb) => {
    if (password !== PASSWORD) return cb?.({ error: "Wrong password" });
    for (const r of rooms.values()) if (r.hostKey === hostKey && r.phase !== "final") { r.hostSocket = socket.id; socket.data = { room: r.code, host: true }; broadcast(r); return cb?.({ code: r.code }); }
    if (!planId && !gameId) return cb?.({ none: true });
    const items = buildItems(planId, gameId); if (!items.length) return cb?.({ error: "Nothing to play: no playable questions." });
    const code = newCode();
    const base = process.env.PUBLIC_URL || socket.handshake.headers.origin || `http://${socket.handshake.headers.host}`;
    const joinUrl = `${base.replace(/\/$/, "")}/?room=${code}`;
    const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 600, color: { dark: "#2A1740", light: "#FFFFFF" } });
    const title = planId ? PLANS.find((p) => p.id === planId).name : items[0].game.title;
    const r = { code, hostKey, hostSocket: socket.id, title, items, gi: -1, qi: -1, phase: "lobby", stage: 0, players: new Map(), ans: {}, res: {}, accepted: {}, pairs: {}, roles: {}, rot: {}, joinUrl, qr, created: Date.now() };
    rooms.set(code, r); socket.data = { room: code, host: true };
    cb?.({ code }); broadcast(r);
  });
  const hostRoom = () => (socket.data?.host ? rooms.get(socket.data.room) : null);
  socket.on("host:next", () => { const r = hostRoom(); if (r && r.phase !== "question") next(r); });
  socket.on("host:reveal", () => { const r = hostRoom(); if (!r || r.phase !== "question") return; if (item(r).game.type === "hint" && r.stage === 0) hintGuessStage(r); else reveal(r); });
  socket.on("host:stage", () => { const r = hostRoom(); if (!r || r.phase !== "question") return; const K = E.TYPES[item(r).game.type].stages?.(curQ(r)) || 0; if (r.stage < K - 1) { r.stage++; setTimers(r); broadcast(r); } });
  socket.on("host:accept", ({ key: gkey }) => {
    const r = hostRoom(); if (!r || r.phase !== "revealed") return;
    const acc = (r.accepted[key(r)] ??= {});
    String(gkey).split("|").forEach((w, i) => { if (w && w !== "(blank)") (acc[i] ??= new Set()).add(w); });
    rescore(r); broadcast(r);
  });
  socket.on("host:end", () => { const r = hostRoom(); if (!r) return; clearTimeout(r.timer); clearTimeout(r.stageTimer); r.phase = "final"; broadcast(r); });
  socket.on("host:kick", ({ id }) => { const r = hostRoom(); if (!r) return; const p = r.players.get(id); if (p?.socket) io.to(p.socket).emit("player:kicked"); r.players.delete(id); broadcast(r); });

  socket.on("player:join", ({ code, name, pid }, cb) => {
    const r = rooms.get(String(code || "").toUpperCase().trim());
    if (!r) return cb?.({ error: "No game with that code. Check the code on the screen." });
    name = String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
    let p = pid && r.players.get(pid);
    if (!p) {
      if (!name) return cb?.({ error: "Please type your name." });
      if (players(r).some((x) => x.name.toLowerCase() === name.toLowerCase())) return cb?.({ error: "That name is taken. Add your surname or an initial." });
      pid = crypto.randomUUID(); p = { id: pid, name }; r.players.set(pid, p);
    }
    p.socket = socket.id; p.connected = true; socket.data = { room: r.code, pid };
    if (r.phase === "question" && item(r).game.type === "closest") ensurePairs(r);
    cb?.({ pid, code: r.code }); broadcast(r);
  });

  socket.on("player:answer", (msg = {}, cb) => {
    const r = rooms.get(socket.data?.room); const p = r?.players.get(socket.data?.pid);
    if (!r || !p || r.phase !== "question") return cb?.({ error: "Too late" });
    const k = key(r), type = item(r).game.type, q = curQ(r), box = r.ans[k];
    const t = Date.now() - r.started;
    if (type === "hint") {
      const ro = r.roles[k] || {};
      if (r.stage === 0 && (p.id === ro.giver || (ro.blockers || []).includes(p.id))) {
        if (box[p.id]?.clues) return cb?.({ error: "Already sent" });
        const clues = (Array.isArray(msg.clues) ? msg.clues : []).slice(0, 3).map((w) => String(w || "").trim().split(/\s+/)[0].slice(0, 30));
        box[p.id] = { clues, t };
      } else if (r.stage === 1 && p.id !== ro.giver && !(ro.blockers || []).includes(p.id)) {
        if (box[p.id]?.value !== undefined) return cb?.({ error: "Already answered" });
        box[p.id] = { ...(box[p.id] || {}), value: String(msg.value ?? "").trim().slice(0, 120), t };
      } else return cb?.({ error: "Not your turn" });
      cb?.({ ok: true });
      if (everyoneDone(r)) { if (r.stage === 0) hintGuessStage(r); else reveal(r); } else broadcast(r);
      return;
    }
    if (box[p.id]) return cb?.({ error: "Already answered" });
    let v = msg.value;
    if (type === "pairs") v = (Array.isArray(v) ? v : []).slice(0, q.parts.length).map((x) => String(x || "").trim().slice(0, 120));
    else if (type === "order") { v = (Array.isArray(v) ? v : []).map(Number); if (v.length !== q.items.length || new Set(v).size !== v.length) return cb?.({ error: "Put every item in order" }); }
    else if (type === "closest") { v = String(v ?? "").replace(/[\s,]/g, "").replace(/[^0-9.\-]/g, ""); if (v === "" || isNaN(Number(v))) return cb?.({ error: "Type a number" }); v = Number(v); }
    else if (type === "choice") v = Number(v);
    else v = String(v ?? "").trim().slice(0, 120);
    box[p.id] = { value: v, t, stage: r.stage };
    cb?.({ ok: true });
    if (everyoneDone(r)) reveal(r); else broadcast(r);
  });

  socket.on("disconnect", () => {
    const r = rooms.get(socket.data?.room); if (!r) return;
    if (socket.data.pid) { const p = r.players.get(socket.data.pid); if (p && p.socket === socket.id) { p.connected = false; p.socket = null; } }
    broadcast(r);
    if (r.phase === "question" && online(r).length && everyoneDone(r)) { if (item(r).game.type === "hint" && r.stage === 0) hintGuessStage(r); else reveal(r); }
  });
});

// ---------- http ----------
app.use(express.json({ limit: "8mb" }));
const admin = (req, res, nextFn) => (req.get("x-admin-password") === PASSWORD ? nextFn() : res.status(401).json({ error: "Wrong password" }));
app.get("/api/admin/data", admin, (_req, res) => res.json({ games: sortedGames(), plans: PLANS, storage: store.describe, mode: store.mode, types: Object.keys(E.TYPES) }));
app.post("/api/admin/reload", admin, async (_req, res) => { try { await loadData(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put("/api/admin/games/:id", admin, async (req, res) => {
  const g = req.body; if (!g || g.id !== req.params.id || !E.TYPES[g.type] || !Array.isArray(g.questions)) return res.status(400).json({ error: "Invalid game" });
  try { await store.write(`games/${g.id}.json`, Buffer.from(JSON.stringify(g, null, 2)), `Update ${g.title}`); GAMES[g.id] = g; res.json({ ok: true, playable: playableIdx(g).length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/admin/plans", admin, async (req, res) => {
  const plans = req.body?.plans; if (!Array.isArray(plans)) return res.status(400).json({ error: "Invalid plans" });
  try { await store.write("plans.json", Buffer.from(JSON.stringify({ plans }, null, 2)), "Update day plans"); PLANS = plans; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/admin/media", admin, express.raw({ type: () => true, limit: "15mb" }), async (req, res) => {
  const orig = String(req.query.name || "file"); const ext = (orig.match(/\.([a-z0-9]{2,4})$/i)?.[1] || "bin").toLowerCase();
  if (!["png", "jpg", "jpeg", "gif", "webp", "mp3", "m4a", "wav", "ogg"].includes(ext)) return res.status(400).json({ error: "Use a picture (png, jpg, gif, webp) or a sound file (mp3, m4a, wav, ogg)." });
  const name = `${orig.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "file"}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  try { await store.write(`media/${name}`, req.body, `Add ${name}`); media.set(name, req.body); res.json({ name }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/media/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  let buf = media.get(name);
  if (!buf) { buf = await store.read(`media/${name}`).catch(() => null); if (!buf) return res.status(404).end(); media.set(name, buf); }
  res.type(path.extname(name)); res.set("Cache-Control", "public, max-age=86400"); res.send(buf);
});
app.get("/api/rooms/:code/results.csv", (req, res) => {
  const r = rooms.get(req.params.code.toUpperCase());
  if (!r || r.hostKey !== req.query.key) return res.status(404).send("Not found");
  const rows = [["Rank", "Name", "Total", ...r.items.map((it) => it.game.title)]];
  board(r).forEach((b, i) => rows.push([i + 1, b.name, b.score, ...r.items.map((_, gi) => totalOf(r, b.id, gi))]));
  const csv = "﻿" + rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${r.title.replace(/[^A-Za-z0-9 -]/g, "")} ${r.code}.csv"`);
  res.send(csv);
});
for (const page of ["host", "admin"]) app.get(`/${page}`, (_req, res) => res.sendFile(path.join(__dirname, "public", `${page}.html`)));
app.use(express.static(path.join(__dirname, "public")));

setInterval(() => { const cut = Date.now() - 8 * 3600e3; for (const [c, r] of rooms) if (r.created < cut) rooms.delete(c); }, 600e3);
loadData().then(() => server.listen(PORT, () => console.log(`The Literature Games on http://localhost:${PORT}  (host: /host, admin: /admin)`)))
  .catch((e) => { console.error("Could not load data:", e.message); process.exit(1); });
