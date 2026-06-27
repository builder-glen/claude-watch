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
import { parseTranscript, summarizeUsage, extractDecisions, sessionStats, firstUserPrompt } from "./lib/parse.mjs";

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

// ── 세션 색인 (목록·검색용). 목록 열 때 mtime 비교로 바뀐 것만 갱신. ──
const INDEX_PATH = join(CW_DIR, "index.json");
const ALIAS_PATH = join(CW_DIR, "aliases.json"); // 사용자가 수정한 제목(영구, 색인 갱신에도 안 덮임)
async function readJson(p, def) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return def; } }
async function writeJson(p, o) { try { await mkdir(CW_DIR, { recursive: true }); await writeFile(p, JSON.stringify(o)); } catch {} }

// JSONL의 실제 cwd에서 프로젝트명(폴더명) 추출 (디렉토리명 뭉개짐 회피)
function extractProject(text, fallback) {
  for (const line of text.split("\n").slice(0, 200)) {
    const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (m && m[1]) return m[1].split("/").filter(Boolean).pop() || fallback;
  }
  return fallback;
}

// entrypoint 추출 — "cli"=사람 인터랙티브, "sdk-cli"=프로그램/앱 자동(노이즈)
function extractEntrypoint(text) {
  for (const line of text.split("\n").slice(0, 200)) {
    const m = line.match(/"entrypoint"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return "";
}

// JSONL의 ai-title(마지막 것) 추출
function extractAiTitle(text) {
  let t = "";
  for (const line of text.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    try { const o = JSON.parse(line); if (o.type === "ai-title" && o.aiTitle) t = o.aiTitle; } catch {}
  }
  return t;
}

async function buildIndex() {
  const sessions = await findSessions();
  const cached = await readJson(INDEX_PATH, {});
  const aliases = await readJson(ALIAS_PATH, {});
  const out = {};
  for (const s of sessions) {
    const prev = cached[s.id];
    if (prev && prev.updatedAt === s.mtime) {
      out[s.id] = prev; // 안 바뀜 → 카드 재사용
    } else {
      try {
        const text = await readFile(s.path, "utf8");
        const events = parseTranscript(text);
        const st = sessionStats(events);
        out[s.id] = {
          id: s.id, project: extractProject(text, s.project), updatedAt: s.mtime,
          interactive: extractEntrypoint(text) === "cli",
          createdAt: st.firstTs ? new Date(st.firstTs).getTime() : s.mtime,
          aiTitle: extractAiTitle(text),
          firstPrompt: firstUserPrompt(events),
          stats: {
            durationMs: (st.firstTs && st.lastTs) ? (new Date(st.lastTs) - new Date(st.firstTs)) : 0,
            decisions: st.decisions, files: st.files, commits: st.commits,
          },
          decisions: extractDecisions(events).map((d) => ({ h: d.header, q: d.question, c: d.chosen })),
        };
      } catch {
        out[s.id] = prev || { id: s.id, project: s.project, updatedAt: s.mtime, createdAt: s.mtime, aiTitle: "", firstPrompt: "", stats: {}, decisions: [] };
      }
    }
    // 제목 해석: 별칭 > ai-title > 첫 질문 (별칭은 매번 현재값 반영)
    out[s.id].alias = aliases[s.id] || "";
    out[s.id].title = aliases[s.id] || out[s.id].aiTitle || out[s.id].firstPrompt || s.id.slice(0, 8);
  }
  await writeJson(INDEX_PATH, out);
  return out;
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
const LIST = await readFile(join(__dirname, "public", "list.html"), "utf8");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/health") return send(res, 200, "text/plain", "ok");

  // 세션 목록 페이지 (리스트 페이지) — 클라이언트가 /api/index 를 받아 렌더
  if (path === "/") {
    return send(res, 200, "text/html; charset=utf-8", LIST);
  }

  // 색인 JSON (목록·검색·CLI 공용). 열 때 mtime 비교로 바뀐 것만 갱신.
  if (path === "/api/index") {
    const idx = await buildIndex();
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(Object.values(idx)));
  }

  // 제목 수정(별칭) — 영구 저장
  const mRename = path.match(/^\/api\/rename\/([\w-]+)$/);
  if (mRename) {
    const id = mRename[1];
    const title = (url.searchParams.get("title") || "").slice(0, 120).trim();
    const aliases = await readJson(ALIAS_PATH, {});
    if (title) aliases[id] = title; else delete aliases[id];
    await writeJson(ALIAS_PATH, aliases);
    return send(res, 200, "application/json", JSON.stringify({ ok: true, id, title }));
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

  // export: 자체완결 HTML(데이터 인라인, SSE 없음) 생성 → ~/.claude-watch/exports/ 저장
  //   ?refresh=1 이면 stale/없는 AI를 그 자리에서 재생성(최신화)
  const mExport = path.match(/^\/export\/([\w-]+)$/);
  if (mExport) {
    const id = mExport[1];
    const sessions = await findSessions();
    const sess = sessions.find((s) => s.id === id);
    if (!sess) return send(res, 404, "application/json", JSON.stringify({ error: "session not found" }));
    try {
      const text = await readFile(sess.path, "utf8");
      const events = parseTranscript(text);
      const usage = summarizeUsage(text); usage.rate = await readRateLimits();
      const refresh = url.searchParams.get("refresh") === "1";
      const cache = {};
      for (const kind of ["summary", "diagram"]) {
        let c = await readCache(id, kind);
        const stale = !c || (c.atEventCount != null && c.atEventCount < events.length);
        if (refresh && stale) {
          try { const out = await runClaude(kind, buildDigest(events)); out.atEventCount = events.length; await writeCache(id, kind, out); c = out; } catch {}
        }
        cache[kind] = (c && c.text) ? c : null;
      }
      // 데이터를 JSON script 태그로 임베드(JS 리터럴이 아니라 JSON.parse로 읽음 → 제어문자/줄바꿈/< 안전).
      // </script> 만 닫힘 방지로 이스케이프.
      const dataJson = JSON.stringify({ events, usage, cache }).replace(/<\/script>/gi, "<\\/script>");
      const inject = `<script type="application/json" id="cw-export-data">${dataJson}</script>`;
      // ⚠️ 치환문자열에 데이터($ 포함)를 직접 넣으면 $&·$' 등이 특수 치환으로 해석됨 → 함수 치환으로 회피
      const html = VIEWER.replace("__SESSION_ID__", () => id).replace("</head>", () => inject + "\n</head>");
      const titleSrc = (events.find((e) => e.kind === "user_text" && e.text && !e.text.startsWith("[")) || {}).text || "session";
      const d = new Date();
      const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
      const clean = (s) => String(s).replace(/[\/\\:*?"<>|\n\r]+/g, " ").trim();
      const proj = clean((sess.project || "").split("/").pop() || "session");
      const title = clean(titleSrc.split("\n")[0]).slice(0, 40);
      const fname = `[${ymd}] ${proj} · ${title}.html`;
      const EXPORT_DIR = join(CW_DIR, "exports");
      await mkdir(EXPORT_DIR, { recursive: true });
      const fpath = join(EXPORT_DIR, fname);
      await writeFile(fpath, html, "utf8");
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, file: fname, path: fpath, hasAI: { summary: !!cache.summary, diagram: !!cache.diagram } }));
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
