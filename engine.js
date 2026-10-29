// Question types: what players see, how answers are checked and scored.
const MAX = 1000;          // points for a perfect, instant answer
const MIN = 500;           // points for a correct answer at the last second

const norm = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ı/g, "i").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "").replace(/ /g, "");
const strict = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const encode = (text) =>
  String(text).split(/\s+/).map((w) => [...w.toUpperCase()].filter((c) => c >= "A" && c <= "Z").map((c) => c.charCodeAt(0) - 64).join(" ")).filter(Boolean).join("   /   ");

// [[hidden]] words in Redacted Riddles
const hiddenWords = (prompt) => [...String(prompt).matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]);
const redact = (prompt, shown) => { let i = 0; return String(prompt).replace(/\[\[(.+?)\]\]/g, (_, w) => (i++ < shown ? w : "█".repeat(Math.max(4, Math.min(10, w.length))))); };

const TYPES = {
  text:    { input: "text" },
  spell:   { input: "text", strict: true },
  code:    { input: "text" },
  pairs:   { input: "parts" },
  steps:   { input: "text", stages: (q) => (q.steps || []).length },
  redact:  { input: "text", stages: (q) => hiddenWords(q.prompt).length + 1 },
  posh:    { input: "text", stages: () => 2 },
  choice:  { input: "choice" },
  order:   { input: "order" },
  closest: { input: "number" },
  unique:  { input: "text" },
  hint:    { input: "hint" },
};

function playable(type, q) {
  switch (type) {
    case "pairs": return (q.clues || []).length && (q.parts || []).every((p) => p.answer);
    case "choice": return q.image && (q.markers || []).length && q.answer != null && q.answer !== "";
    case "order": return (q.items || []).length >= 2 && q.items.every((i) => i.label && i.year !== "" && i.year != null);
    case "closest": return q.prompt && q.answer !== "" && q.answer != null && !isNaN(Number(q.answer));
    case "unique": return q.category && (q.answers || []).length;
    case "hint": return q.answer;
    case "steps": return (q.steps || []).length && q.answer;
    case "posh": return q.posh && q.pop && q.answer;
    default: return (q.prompt || q.category || q.image || q.audio) && q.answer && !(q.needs === "audio" && !q.audio);
  }
}

function answerText(type, q) {
  if (type === "pairs") return q.parts.map((p) => p.answer).join(" / ");
  if (type === "order") return [...q.items].sort((a, b) => a.year - b.year).map((i) => i.label).join("  →  ");
  if (type === "choice") return String(q.answer);
  if (type === "closest") return Number(q.answer).toLocaleString("en-GB") + (q.unit ? " " + q.unit : "");
  if (type === "unique") return `${q.answers.length} possible answers`;
  return q.answer;
}

// what everyone may see while the question is open (never the answer)
function publicQuestion(type, q, stage) {
  switch (type) {
    case "code": return { category: q.category, text: encode(q.answer) };
    case "pairs": return { clues: q.clues };
    case "steps": return { steps: q.steps.slice(0, stage + 1), total: q.steps.length };
    case "redact": return { prompt: redact(q.prompt, stage) };
    case "posh": return { posh: q.posh, poshImage: q.poshImage, pop: stage >= 1 ? q.pop : null, popImage: stage >= 1 ? q.popImage : null };
    case "choice": return { prompt: q.prompt, image: q.image, markers: q.markers.map((m) => ({ n: m.n, x: m.x, y: m.y })) };
    case "order": return { prompt: q.prompt || "Put these in order, earliest first.", items: q.items.map((i) => i.label) };
    case "closest": return { prompt: q.prompt, unit: q.unit || "" };
    case "unique": return { category: q.category };
    case "hint": return { category: q.category };
    default: return { prompt: q.prompt, image: q.image, audio: q.audio, category: q.category };
  }
}

function speedPoints(t, limitMs) { return Math.round(MIN + (MAX - MIN) * Math.max(0, 1 - t / limitMs)); }

function matchText(type, q, value, accepted) {
  if (type === "spell") { const v = strict(value); return !!v && (v === strict(q.answer) || accepted.has(norm(value))); }
  const n = norm(value); if (!n) return false;
  return [q.answer, ...(q.accept || [])].map(norm).includes(n) || accepted.has(n);
}

// returns { points: {pid: n}, correct: {pid: bool} }
function score(type, q, answers, ctx) {
  const pts = {}, ok = {};
  const acc = ctx.accepted || {};
  const limit = ctx.limitMs;
  if (type === "closest") {
    const target = Number(q.answer);
    const rows = (ctx.pairs || []).map((members) => {
      const gs = members.map((pid) => answers[pid]).filter((a) => a && a.value !== "" && !isNaN(Number(a.value))).map((a) => Number(a.value));
      return { members, avg: gs.length ? gs.reduce((s, x) => s + x, 0) / gs.length : null };
    }).filter((r) => r.avg != null).map((r) => ({ ...r, dist: Math.abs(r.avg - target) }));
    const best = Math.min(...rows.map((r) => r.dist));
    for (const r of rows) for (const pid of r.members) { const win = r.dist === best; ok[pid] = win; pts[pid] = win ? MAX : 0; }
    return { points: pts, correct: ok, pairs: rows };
  }
  if (type === "unique") {
    const valid = new Set([...(q.answers || []).map(norm), ...(acc[0] || [])]);
    const count = {};
    for (const a of Object.values(answers)) { const n = norm(a.value); if (n) count[n] = (count[n] || 0) + 1; }
    for (const [pid, a] of Object.entries(answers)) { const n = norm(a.value); const good = !!n && valid.has(n); ok[pid] = good && count[n] === 1; pts[pid] = ok[pid] ? MAX : 0; }
    return { points: pts, correct: ok, valid };
  }
  if (type === "hint") return scoreHint(q, answers, ctx);
  for (const [pid, a] of Object.entries(answers)) {
    let good = false;
    if (type === "pairs") good = q.parts.every((p, i) => matchText("text", p, (a.value || [])[i], acc[i] || new Set()));
    else if (type === "choice") good = String(a.value) === String(q.answer);
    else if (type === "order") { const want = q.items.map((it, i) => ({ i, y: Number(it.year) })).sort((x, y) => x.y - y.y).map((x) => x.i); good = Array.isArray(a.value) && a.value.join(",") === want.join(","); }
    else good = matchText(type, q, a.value, acc[0] || new Set());
    ok[pid] = good;
    let p = good ? speedPoints(a.t, limit) : 0;
    if (good && type === "posh" && a.stage === 0) p *= 2;
    pts[pid] = p;
  }
  return { points: pts, correct: ok };
}

function scoreHint(q, answers, ctx) {
  const pts = {}, ok = {};
  const r = ctx.roles || {};
  const clues = (answers[r.giver]?.clues || []).map(norm).filter(Boolean);
  const blocks = {};
  for (const b of r.blockers || []) blocks[b] = (answers[b]?.clues || []).map(norm).filter((w) => w && clues.includes(w));
  const blocked = Object.values(blocks).some((l) => l.length);
  const acc = ctx.accepted?.[0] || new Set();
  const isRight = (v) => [q.answer, ...(q.accept || [])].map(norm).includes(norm(v)) || acc.has(norm(v));
  const guessRight = isRight(answers[r.guesser]?.value);
  if (r.guesser) { ok[r.guesser] = guessRight && !blocked; pts[r.guesser] = ok[r.guesser] ? MAX : 0; }
  if (r.giver) { ok[r.giver] = guessRight && !blocked; pts[r.giver] = ok[r.giver] ? MAX : 0; }
  for (const b of r.blockers || []) { ok[b] = blocks[b].length > 0; pts[b] = ok[b] ? 500 : 0; }
  for (const [pid, a] of Object.entries(answers)) {
    if (pid === r.guesser || pid === r.giver || (r.blockers || []).includes(pid)) continue;
    ok[pid] = isRight(a.value); pts[pid] = ok[pid] ? 300 : 0;
  }
  return { points: pts, correct: ok, clues: answers[r.giver]?.clues || [], blocks, blocked, guess: answers[r.guesser]?.value || "" };
}

module.exports = { TYPES, norm, encode, hiddenWords, playable, answerText, publicQuestion, score, MAX };
