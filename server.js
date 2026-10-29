// The Literature Games: a small live quiz server for the classroom.
// Host screen: /host   Students: /  (join with a room code)
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- games ----------
function loadGames() {
  const dir = path.join(__dirname, "games");
  const games = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    games[g.id] = g;
  }
  return games;
}
const GAMES = loadGames();

const encode = (text) =>
  text.split(/\s+/).map((w) => [...w.toUpperCase()].filter((c) => c >= "A" && c <= "Z").map((c) => c.charCodeAt(0) - 64).join(" ")).filter(Boolean).join("   /   ");

function prompt(game, q) {
  if (game.id === "crack-the-code") return { category: q.category, text: encode(q.answer) };
  return { category: q.category || "", text: q.prompt || "" };
}

// lower-case, drop accents and punctuation, ignore a leading "the"
const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ı/g, "i").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "").replace(/ /g, "");

// ---------- rooms ----------
const rooms = new Map();
const newCode = () => {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c;
  do c = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join("");
  while (rooms.has(c));
  return c;
};

function points(room, t) {
  const limit = room.game.timeLimit * 1000;
  const max = Math.round(10000 / room.game.questions.length);
  return Math.round(max / 2 + (max / 2) * Math.max(0, 1 - t / limit));
}

function isCorrect(room, q, text) {
  const n = norm(text);
  if (!n) return false;
  const ok = [q.answer, ...(q.accept || [])].map(norm);
  return ok.includes(n) || room.accepted[room.qIndex]?.has(n);
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function hostState(room) {
  const q = room.game.questions[room.qIndex];
  const answers = room.answers[room.qIndex] || {};
  const players = [...room.players.values()];
  const st = {
    code: room.code, phase: room.phase, game: { id: room.game.id, title: room.game.title, intro: room.game.intro, count: room.game.questions.length, timeLimit: room.game.timeLimit },
    qIndex: room.qIndex, deadline: room.deadline,
    players: players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, answered: !!answers[p.id], score: p.score })),
    leaderboard: players.map((p) => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score),
    joinUrl: room.joinUrl, qr: room.qr,
  };
  if (q && room.phase !== "lobby") st.question = prompt(room.game, q);
  if (room.phase === "revealed" || room.phase === "final") {
    st.answer = q?.answer;
    const groups = {};
    for (const [pid, a] of Object.entries(answers)) {
      const k = norm(a.text) || "(blank)";
      groups[k] ??= { text: a.text, correct: a.correct, names: [] };
      groups[k].names.push(room.players.get(pid)?.name || "?");
    }
    st.groups = Object.entries(groups).map(([key, g]) => ({ key, ...g })).sort((a, b) => b.correct - a.correct || b.names.length - a.names.length);
    st.missing = players.filter((p) => !answers[p.id]).map((p) => p.name);
  }
  return st;
}

function playerState(room, p) {
  const q = room.game.questions[room.qIndex];
  const a = (room.answers[room.qIndex] || {})[p.id];
  const rank = [...room.players.values()].sort((x, y) => y.score - x.score).findIndex((x) => x.id === p.id) + 1;
  const st = { phase: room.phase, name: p.name, score: p.score, rank, total: room.players.size, qIndex: room.qIndex, count: room.game.questions.length, title: room.game.title, intro: room.game.intro, deadline: room.deadline, timeLimit: room.game.timeLimit };
  if (q && room.phase === "question") { st.question = prompt(room.game, q); st.myAnswer = a?.text || null; }
  if (room.phase === "revealed") { st.question = prompt(room.game, q); st.answer = q.answer; st.myAnswer = a?.text || null; st.correct = !!a?.correct; st.gained = a?.points || 0; }
  return st;
}

function broadcast(room) {
  if (room.hostSocket) io.to(room.hostSocket).emit("host:state", hostState(room));
  for (const p of room.players.values()) if (p.socket) io.to(p.socket).emit("player:state", playerState(room, p));
}

function reveal(room) {
  if (room.phase !== "question") return;
  clearTimeout(room.timer);
  room.phase = "revealed";
  broadcast(room);
}

function rescore(room, qi) {
  const q = room.game.questions[qi];
  const saved = room.qIndex; room.qIndex = qi;
  for (const [pid, a] of Object.entries(room.answers[qi] || {})) {
    const p = room.players.get(pid); if (!p) continue;
    const now = isCorrect(room, q, a.text);
    if (now && !a.correct) { a.correct = true; a.points = points(room, a.t); p.score += a.points; }
  }
  room.qIndex = saved;
}

function askQuestion(room, i) {
  room.qIndex = i; room.phase = "question";
  room.answers[i] = {}; room.started = Date.now();
  room.deadline = room.started + room.game.timeLimit * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => reveal(room), room.game.timeLimit * 1000 + 300);
  broadcast(room);
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  socket.on("host:create", async ({ gameId, hostKey }, cb) => {
    const game = GAMES[gameId]; if (!game) return cb?.({ error: "Unknown game" });
    // re-attach to an existing room after a page reload
    for (const r of rooms.values()) if (r.hostKey === hostKey && r.game.id === gameId && r.phase !== "closed") { r.hostSocket = socket.id; socket.data.room = r.code; socket.data.host = true; broadcast(r); return cb?.({ code: r.code }); }
    const code = newCode();
    const base = process.env.PUBLIC_URL || socket.handshake.headers.origin || `http://${socket.handshake.headers.host}`;
    const joinUrl = `${base.replace(/\/$/, "")}/?room=${code}`;
    const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 600, color: { dark: "#2A1740", light: "#FFFFFF" } });
    const room = { code, game, hostKey, hostSocket: socket.id, players: new Map(), phase: "lobby", qIndex: -1, answers: {}, accepted: {}, joinUrl, qr, created: Date.now() };
    rooms.set(code, room); socket.data.room = code; socket.data.host = true;
    cb?.({ code }); broadcast(room);
  });

  const hostRoom = () => { const r = rooms.get(socket.data.room); return socket.data.host && r ? r : null; };
  socket.on("host:start", () => { const r = hostRoom(); if (r && r.phase === "lobby") askQuestion(r, 0); });
  socket.on("host:reveal", () => { const r = hostRoom(); if (r) reveal(r); });
  socket.on("host:next", () => {
    const r = hostRoom(); if (!r || r.phase !== "revealed") return;
    if (r.qIndex + 1 < r.game.questions.length) askQuestion(r, r.qIndex + 1); else { r.phase = "final"; broadcast(r); }
  });
  socket.on("host:accept", ({ key }) => {
    const r = hostRoom(); if (!r || r.phase !== "revealed") return;
    (r.accepted[r.qIndex] ??= new Set()).add(key); rescore(r, r.qIndex); broadcast(r);
  });
  socket.on("host:kick", ({ id }) => { const r = hostRoom(); if (!r) return; const p = r.players.get(id); if (p?.socket) io.to(p.socket).emit("player:kicked"); r.players.delete(id); broadcast(r); });

  socket.on("player:join", ({ code, name, pid }, cb) => {
    const r = rooms.get(String(code || "").toUpperCase().trim());
    if (!r) return cb?.({ error: "No game with that code. Check the code on the screen." });
    name = String(name || "").trim().slice(0, 24);
    let p = pid && r.players.get(pid);
    if (!p) {
      if (!name) return cb?.({ error: "Please type your name." });
      if ([...r.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase())) return cb?.({ error: "That name is taken. Add your surname or an initial." });
      pid = crypto.randomUUID();
      p = { id: pid, name, score: 0 }; r.players.set(pid, p);
    }
    p.socket = socket.id; p.connected = true;
    socket.data.room = r.code; socket.data.pid = pid;
    cb?.({ pid, code: r.code }); broadcast(r);
  });

  socket.on("player:answer", ({ text }, cb) => {
    const r = rooms.get(socket.data.room); const p = r?.players.get(socket.data.pid);
    if (!r || !p || r.phase !== "question") return cb?.({ error: "Too late" });
    const ans = r.answers[r.qIndex];
    if (ans[p.id]) return cb?.({ error: "Already answered" });
    text = String(text || "").trim().slice(0, 120);
    const t = Date.now() - r.started;
    const correct = isCorrect(r, r.game.questions[r.qIndex], text);
    ans[p.id] = { text, t, correct, points: correct ? points(r, t) : 0 };
    p.score += ans[p.id].points;
    cb?.({ ok: true });
    if (connectedPlayers(r).every((x) => ans[x.id])) reveal(r); else broadcast(r);
  });

  socket.on("disconnect", () => {
    const r = rooms.get(socket.data.room); if (!r) return;
    if (socket.data.pid) { const p = r.players.get(socket.data.pid); if (p && p.socket === socket.id) { p.connected = false; p.socket = null; } }
    broadcast(r);
    if (r.phase === "question" && connectedPlayers(r).length && connectedPlayers(r).every((x) => r.answers[r.qIndex][x.id])) reveal(r);
  });
});

// ---------- http ----------
app.get("/api/games", (_req, res) => res.json(Object.values(GAMES).map((g) => ({ id: g.id, title: g.title, count: g.questions.length }))));
app.get("/api/rooms/:code/results.csv", (req, res) => {
  const r = rooms.get(req.params.code.toUpperCase());
  if (!r || r.hostKey !== req.query.key) return res.status(404).send("Not found");
  const qs = r.game.questions;
  const rows = [["Rank", "Name", "Score", ...qs.map((_, i) => `Q${i + 1} answer`), ...qs.map((_, i) => `Q${i + 1} points`)]];
  [...r.players.values()].sort((a, b) => b.score - a.score).forEach((p, i) => {
    rows.push([i + 1, p.name, p.score, ...qs.map((_, k) => r.answers[k]?.[p.id]?.text ?? ""), ...qs.map((_, k) => r.answers[k]?.[p.id]?.points ?? 0)]);
  });
  const csv = "﻿" + rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${r.game.title.replace(/[^A-Za-z0-9 ]/g, "")} ${r.code}.csv"`);
  res.send(csv);
});
app.get("/host", (_req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.use(express.static(path.join(__dirname, "public")));

// forget rooms after 6 hours
setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [c, r] of rooms) if (r.created < cut) rooms.delete(c); }, 600e3);

server.listen(PORT, () => console.log(`The Literature Games on http://localhost:${PORT}  (host: /host)`));
