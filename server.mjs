// claude-watch MVP 서버 — 의존성 0 (Node 내장 모듈만)
//  • ~/.claude/projects 아래의 세션 JSONL을 탐색/감시
//  • GET /              세션 목록(최근순)
//  • GET /s/:id         세션 전용 HTML 뷰어
//  • GET /api/events/:id 파싱된 이벤트(JSON) — 초기 로드용
//  • GET /events/:id    SSE: 파일이 바뀔 때마다 전체 스냅샷 push (실시간)
//  • GET /health        서버 생존 확인(statusLine이 ping)

import http from "node:http";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseTranscript, summarizeUsage } from "./lib/parse.mjs";

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

// 구독 한도(rate_limits)는 statusLine stdin에만 있다 → statusline.sh가 떨군 파일에서 읽는다.
// 계정 전체 기준(세션별 아님). 데이터 없으면 null.
const CW_DIR = join(homedir(), ".claude-watch");
const CACHE_DIR = join(CW_DIR, "cache");

// AI 결과 캐시: ~/.claude-watch/cache/<sessionId>-<kind>.json = { text, usage, atEventCount }
const cachePath = (id, kind) => join(CACHE_DIR, `${id}-${kind}.json`);
async function readCache(id, kind) {
  try { return JSON.parse(await readFile(cachePath(id, kind), "utf8")); } catch { return null; }
}
async function writeCache(id, kind, data) {
  try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(cachePath(id, kind), JSON.stringify(data)); } catch {}
}

async function readRateLimits() {
  try {
    const o = JSON.parse(await readFile(join(CW_DIR, "statusline-input.json"), "utf8"));
    const rl = o.rate_limits;
    if (!rl) return null;
    const pct = (x) => (x && typeof x.used_percentage === "number") ? Math.round(x.used_percentage) : null;
    const fiveHour = pct(rl.five_hour), sevenDay = pct(rl.seven_day);
    if (fiveHour == null && sevenDay == null) return null;
    return { fiveHour, sevenDay };
  } catch { return null; }
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

  // 캐시 읽기 (생성 안 함) — 뷰어가 탭 열 때 호출, 있으면 즉시 표시
  const mCache = path.match(/^\/api\/ai-cache\/(summary|diagram)\/([\w-]+)$/);
  if (mCache) {
    const [, kind, id] = mCache;
    const c = await readCache(id, kind);
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(c || { cached: false }));
  }

  // AI 생성 (요약/다이어그램) — 기존 Claude Code 인증으로 headless 호출, 별도 키 불필요. 결과는 캐시에 저장.
  const mAi = path.match(/^\/api\/ai\/(summary|diagram)\/([\w-]+)$/);
  if (mAi) {
    const [, kind, id] = mAi;
    const file = await pathForSession(id);
    if (!file) return send(res, 404, "application/json", JSON.stringify({ error: "session not found" }));
    try {
      const events = await eventsForFile(file);
      const out = await runClaude(kind, buildDigest(events));
      out.atEventCount = events.length;
      await writeCache(id, kind, out);
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(out));
    } catch (e) {
      return send(res, 500, "application/json", JSON.stringify({ error: String(e?.message || e) }));
    }
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
      const text = await readFile(file, "utf8");
      const events = parseTranscript(text);
      const usage = summarizeUsage(text);
      usage.rate = await readRateLimits();
      res.write(`event: snapshot\ndata: ${JSON.stringify(events)}\n\n`);
      res.write(`event: usage\ndata: ${JSON.stringify(usage)}\n\n`);
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

// 세션 이벤트 → AI에 넘길 압축 다이제스트(사용자 질문 + 도구 사용 + 변경 파일)
function buildDigest(events) {
  const prompts = [];
  const edits = new Set();
  const writes = new Set();
  const cmds = [];
  for (const e of events) {
    if (e.kind === "user_text" && e.text && !e.text.startsWith("[")) prompts.push(e.text.slice(0, 300));
    if (e.kind === "tool_use") {
      const f = e.input?.file_path;
      if (e.name === "Edit" && f) edits.add(f);
      if (e.name === "Write" && f) writes.add(f);
      if (e.name === "Bash" && e.input?.command) cmds.push(e.input.command.slice(0, 120));
    }
  }
  const short = (p) => p.replace(/^.*\/(?=.*\/)/, "…/");
  return [
    "## 사용자 요청들",
    prompts.slice(0, 12).map((p, i) => `${i + 1}. ${p}`).join("\n") || "(없음)",
    "\n## 생성된 파일",
    [...writes].map(short).join("\n") || "(없음)",
    "\n## 수정된 파일",
    [...edits].map(short).join("\n") || "(없음)",
    "\n## 실행한 명령(일부)",
    cmds.slice(0, 20).join("\n") || "(없음)",
  ].join("\n").slice(0, 8000);
}

const PROMPTS = {
  summary:
    "다음은 Claude Code 코딩 세션의 작업 기록이다. 한국어로 핵심만 6줄 이내로 요약하라. " +
    "무엇을 하려 했고, 어떤 작업을 했으며, 어떤 파일을 왜 바꿨는지 중심으로. 군더더기 금지.\n\n",
  diagram:
    "다음 코딩 세션의 변경을 Mermaid flowchart로 그려라. 코드펜스(```) 없이 mermaid 텍스트만 출력. " +
    "파일/모듈 간 관계와 데이터 흐름 중심으로, 한눈에 구조가 보이게. 노드는 한국어 라벨 가능.\n\n",
};

// 기존 Claude Code 인증으로 headless 호출 (별도 API 키 불필요)
// json 출력으로 받아 결과 텍스트 + 토큰/비용(usage)을 함께 반환한다.
function runClaude(kind, digest) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", "haiku", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(err.trim() || `claude exited ${code}`));
      try {
        const o = JSON.parse(out);
        const u = o.usage || {};
        resolve({
          text: (o.result || "").trim(),
          usage: {
            input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
            output: u.output_tokens || 0,
            cost: o.total_cost_usd ?? null,
            durationMs: o.duration_ms ?? null,
          },
        });
      } catch (e) {
        reject(new Error("claude 응답 파싱 실패: " + String(e?.message || e)));
      }
    });
    child.stdin.write(PROMPTS[kind] + digest);
    child.stdin.end();
  });
}

server.listen(PORT, () => {
  console.log(`claude-watch listening on http://localhost:${PORT}`);
});
