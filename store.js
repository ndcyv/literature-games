// Where games, day plans and media live.
// GitHub (private data repository) when GITHUB_TOKEN and DATA_REPO are set; otherwise a local folder.
const fs = require("fs");
const path = require("path");

function localStore(dir) {
  const full = (p) => path.join(dir, p);
  return {
    mode: "local",
    describe: `local folder (${dir}). Changes are lost when the server restarts.`,
    async list(sub) { try { return fs.readdirSync(full(sub)).filter((f) => !f.startsWith(".")); } catch { return []; } },
    async read(p) { try { return fs.readFileSync(full(p)); } catch { return null; } },
    async write(p, buf) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.writeFileSync(full(p), buf); },
    async remove(p) { try { fs.unlinkSync(full(p)); } catch {} },
  };
}

function githubStore(repo, token, branch) {
  const api = `https://api.github.com/repos/${repo}/contents/`;
  const shas = new Map();
  const headers = (extra = {}) => ({ Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "literature-games", ...extra });
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  async function meta(p) {
    const r = await fetch(`${api}${enc(p)}?ref=${branch}`, { headers: headers({ Accept: "application/vnd.github+json" }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    return r.json();
  }
  return {
    mode: "github",
    describe: `private GitHub repository ${repo} (${branch})`,
    async list(sub) {
      const m = await meta(sub); if (!Array.isArray(m)) return [];
      for (const f of m) shas.set(f.path, f.sha);
      return m.filter((f) => f.type === "file").map((f) => f.name);
    },
    async read(p) {
      const r = await fetch(`${api}${enc(p)}?ref=${branch}`, { headers: headers({ Accept: "application/vnd.github.raw+json" }) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async write(p, buf, message) {
      let sha = shas.get(p);
      if (sha === undefined) { const m = await meta(p); sha = m && !Array.isArray(m) ? m.sha : null; }
      const body = { message: message || `Update ${p}`, content: Buffer.from(buf).toString("base64"), branch };
      if (sha) body.sha = sha;
      let r = await fetch(`${api}${enc(p)}`, { method: "PUT", headers: headers({ Accept: "application/vnd.github+json", "Content-Type": "application/json" }), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) { // stale sha: fetch the current one and retry once
        const m = await meta(p); if (m && m.sha) body.sha = m.sha;
        r = await fetch(`${api}${enc(p)}`, { method: "PUT", headers: headers({ Accept: "application/vnd.github+json", "Content-Type": "application/json" }), body: JSON.stringify(body) });
      }
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
      const j = await r.json(); shas.set(p, j.content.sha);
    },
    async remove(p) {
      const m = await meta(p); if (!m || Array.isArray(m)) return;
      await fetch(`${api}${enc(p)}`, { method: "DELETE", headers: headers({ Accept: "application/vnd.github+json", "Content-Type": "application/json" }), body: JSON.stringify({ message: `Delete ${p}`, sha: m.sha, branch }) });
      shas.delete(p);
    },
  };
}

module.exports = function makeStore() {
  const { GITHUB_TOKEN, DATA_REPO, DATA_BRANCH } = process.env;
  if (GITHUB_TOKEN && DATA_REPO) return githubStore(DATA_REPO.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, ""), GITHUB_TOKEN, DATA_BRANCH || "main");
  return localStore(process.env.DATA_DIR || path.join(__dirname, "data"));
};
