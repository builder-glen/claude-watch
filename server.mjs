// claude-watch MVP 서버 — 의존성 0 (Node 내장 모듈만)
//  • ~/.claude/projects 아래의 세션 JSONL을 탐색/감시
//  • GET /              세션 목록(최근순)
//  • GET /s/:id         세션 전용 HTML 뷰어
//  • GET /api/events/:id 파싱된 이벤트(JSON) — 초기 로드용
//  • GET /events/:id    SSE: 파일이 바뀔 때마다 전체 스냅샷 push (실시간)
//  • GET /health        서버 생존 확인(statusLine이 ping)

import http from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseTranscript } from "./lib/parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CW_PORT || 4317);
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ── 세션 인덱스: <세션id> → 파일 경로 ────────────────────────────────
async function findSessions() {
  const out = [];
  let projects = [];
  try { projects = await readdir(PROJECTS_DIR); } catch { return out; }
  for (const p of projects) {
    const dir = join(PROJECTS_DIR, p);
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      let st;
      try { st = await stat(full); } catch { continue; }
      out.push({
        id: basename(f, ".jsonl"),
        path: full,
        project: p.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/"),
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function pathForSession(id) {
  const sessions = await findSessions();
  return sessions.find((s) => s.id === id)?.path || null;
}

async function eventsForFile(file) {
  const text = await readFile(file, "utf8");
  return parseTranscript(text);
}

// ── 라우팅 ───────────────────────────────────────────────────────────
const VIEWER = await readFile(join(__dirname, "public", "viewer.html"), "utf8");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/health") return send(res, 200, "text/plain", "ok");

  // 세션 목록
  if (path === "/") {
    const sessions = await findSessions();
    return send(res, 200, "text/html; charset=utf-8", renderIndex(sessions));
  }

  // 세션 뷰어 셸 (sessionId 주입)
  const mView = path.match(/^\/s\/([\w-]+)$/);
  if (mView) {
    const html = VIEWER.replace("__SESSION_ID__", mView[1]);
    return send(res, 200, "text/html; charset=utf-8", html);
  }

  // 초기 이벤트(JSON)
  const mApi = path.match(/^\/api\/events\/([\w-]+)$/);
  if (mApi) {
    const file = await pathForSession(mApi[1]);
    if (!file) return send(res, 404, "application/json", JSON.stringify({ error: "session not found" }));
    const events = await eventsForFile(file);
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(events));
  }

  // SSE 실시간 스트림
  const mSse = path.match(/^\/events\/([\w-]+)$/);
  if (mSse) {
    const file = await pathForSession(mSse[1]);
    if (!file) { res.writeHead(404); return res.end(); }
    return startSse(req, res, file);
  }

  send(res, 404, "text/plain", "not found");
});

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

// SSE: 연결 시 스냅샷 1회 + 파일 변경 때마다 스냅샷 재전송(디바운스)
function startSse(req, res, file) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  const push = async () => {
    if (closed) return;
    try {
      const events = await eventsForFile(file);
      res.write(`event: snapshot\ndata: ${JSON.stringify(events)}\n\n`);
    } catch { /* 파일 일시적 읽기 실패는 무시 */ }
  };

  push(); // 최초 스냅샷

  let timer = null;
  let watcher;
  try {
    watcher = watch(file, () => {
      clearTimeout(timer);
      timer = setTimeout(push, 150); // 잦은 append를 묶음
    });
  } catch { /* watch 실패 시 스냅샷만 제공 */ }

  const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    closed = true;
    clearInterval(ping);
    clearTimeout(timer);
    watcher?.close();
  });
}

function renderIndex(sessions) {
  const rows = sessions.slice(0, 50).map((s) => {
    const when = new Date(s.mtime).toLocaleString("ko-KR");
    const kb = (s.size / 1024).toFixed(0);
    return `<li><a href="/s/${s.id}"><span class="proj">${esc(s.project)}</span>
      <span class="meta">${when} · ${kb}KB · ${s.id.slice(0, 8)}</span></a></li>`;
  }).join("");
  return `<!doctype html><html lang="ko"><meta charset="utf-8">
  <title>claude-watch — 세션 목록</title>
  <style>
    body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
    h1{font-size:20px}ul{list-style:none;padding:0}
    li a{display:flex;justify-content:space-between;gap:12px;padding:12px 14px;margin:6px 0;background:#fff;border:1px solid #eee;border-radius:10px;text-decoration:none;color:inherit}
    li a:hover{border-color:#c7a;background:#fffafd}
    .proj{font-weight:600}.meta{color:#999;font-size:12px;white-space:nowrap}
  </style>
  <h1>🦞 claude-watch · 세션 목록</h1>
  <ul>${rows || "<p>세션이 없습니다.</p>"}</ul>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

server.listen(PORT, () => {
  console.log(`claude-watch listening on http://localhost:${PORT}`);
});
