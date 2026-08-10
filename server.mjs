// claude-watch MVP 서버 — 의존성 0 (Node 내장 모듈만)
//  • ~/.claude/projects 아래의 세션 JSONL을 탐색/감시
//  • GET /              세션 목록(최근순)
//  • GET /s/:id         세션 전용 HTML 뷰어
//  • GET /api/session/:id 이벤트 + 집계(스킬·도구·서브에이전트·모델·파일) — 뷰어 첫 로드용
//  • GET /api/events/:id  파싱된 이벤트만(JSON) — 구버전 호환
//  • GET /events/:id    SSE: init(1회) 후 patch(달라진 뒷부분만) push
//  • GET /health        서버 생존 확인(statusLine이 ping)

import http from "node:http";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  parseTranscript, summarizeUsage, extractDecisions, sessionStats, firstUserPrompt,
  extractSkills, toolStats, extractAgents, modelStats, fileChanges, turnCount, shortModel, modelFamily,
  completedAgentIds,
} from "./lib/parse.mjs";
import { maskEvents, maskAgg, maskText } from "./lib/sanitize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CW_PORT || 4317);
// 이 서버는 세션 전문(코드·파일 내용·명령 출력·자격증명)을 그대로 내보낸다.
// 인증이 없으므로 기본은 루프백 전용. 같은 와이파이의 다른 기기에서 접근하지 못한다.
// 굳이 열어야 하면 CW_HOST=0.0.0.0 으로 명시해야 한다(권장하지 않음).
const HOST = process.env.CW_HOST || "127.0.0.1";
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

// ── 서브에이전트 전사 ────────────────────────────────────────────────
// 부모 로그에는 호출과 실행 요약만 있고, 에이전트 내부 과정은 별도 파일에 있다:
//   <프로젝트>/<세션id>/subagents/agent-<agentId>.jsonl  (+ .meta.json 사이드카)
// 비동기 에이전트는 부모 쪽에 토큰/도구수가 안 남으므로 이 파일에서 직접 집계한다.
function subagentDir(sessionFile, id) {
  return join(dirname(sessionFile), id, "subagents");
}

async function readSubagentStats(dir, agentId) {
  try {
    const text = await readFile(join(dir, `agent-${agentId}.jsonl`), "utf8");
    const ev = parseTranscript(text);
    const ms = modelStats(ev);
    // 토큰은 부모 로그의 totalTokens와 같은 기준으로 센다 = 마지막 응답의 (신규+캐시생성+캐시읽기+출력).
    // 전체 합산을 쓰면 캐시 재읽기가 매 턴 더해져 수천만 토큰으로 부풀어 오른다.
    let last = null;
    for (const e of ev) if (e.usage) last = e.usage;
    const tokens = last ? (last.in || 0) + (last.out || 0) + (last.cw || 0) + (last.cr || 0) : null;
    return {
      tokens,
      tools: ev.filter((e) => e.kind === "tool_use").length,
      model: ms.current || (ms.list[0] && ms.list[0].model) || "",
      events: ev.length,
    };
  } catch { return null; }
}

// 에이전트 목록에 전사 파일 기반 실측치를 덧붙인다(부모 메타가 없는 비동기 건 보강).
async function enrichAgents(agents, sessionFile, id) {
  if (!agents.length) return agents;
  const dir = subagentDir(sessionFile, id);
  let has = false;
  try { has = (await stat(dir)).isDirectory(); } catch { return agents; }
  if (!has) return agents;
  return Promise.all(agents.map(async (a) => {
    if (a.tokens != null && a.tools != null) return { ...a, hasTranscript: true };
    const s = await readSubagentStats(dir, a.id);
    if (!s) return a;
    return { ...a, tokens: a.tokens ?? s.tokens, tools: a.tools ?? s.tools, model: a.model || s.model, hasTranscript: true };
  }));
}

// 세션 뷰어가 첫 로드에 받는 모든 것(이벤트 + 집계). SSE는 이후 증분만 보낸다.
async function sessionPayload(sess) {
  const text = await readFile(sess.path, "utf8");
  const events = parseTranscript(text);
  const usage = summarizeUsage(text);
  usage.rate = await readRateLimits();
  const st = sessionStats(events);
  const agents = await enrichAgents(extractAgents(events, completedAgentIds(text)), sess.path, sess.id);
  return {
    events,
    usage,
    agg: {
      turns: turnCount(events),
      skills: extractSkills(events),
      tools: toolStats(events),
      agents,
      models: modelStats(events),
      files: fileChanges(events),
      decisions: extractDecisions(events),
      stats: st,
    },
    session: {
      id: sess.id,
      project: sess.project,
      cwd: extractCwd(text),
      path: sess.path,
      firstTs: st.firstTs,
      lastTs: st.lastTs,
    },
  };
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
const PROJECT_OVERRIDE_PATH = join(CW_DIR, "project-overrides.json"); // 사용자가 재지정한 프로젝트(영구, 원본 로그 불변)
async function readJson(p, def) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return def; } }
async function writeJson(p, o) { try { await mkdir(CW_DIR, { recursive: true }); await writeFile(p, JSON.stringify(o)); } catch {} }

// JSONL에 기록된 실제 작업 디렉터리(cwd) 원문
function extractCwd(text) {
  for (const line of text.split("\n").slice(0, 200)) {
    const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
  }
  return "";
}

// JSONL의 실제 cwd에서 프로젝트명(폴더명) 추출 (디렉토리명 뭉개짐 회피)
function extractProject(text, fallback) {
  const cwd = extractCwd(text);
  return cwd ? (cwd.split("/").filter(Boolean).pop() || fallback) : fallback;
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
  const overrides = await readJson(PROJECT_OVERRIDE_PATH, {});
  const out = {};
  for (const s of sessions) {
    const prev = cached[s.id];
    if (prev && prev.updatedAt === s.mtime) {
      out[s.id] = prev; // 안 바뀜 → 카드 재사용
      if (out[s.id].projectRaw == null) out[s.id].projectRaw = out[s.id].project; // 구버전 캐시 마이그레이션
    } else {
      try {
        const text = await readFile(s.path, "utf8");
        const events = parseTranscript(text);
        const st = sessionStats(events);
        const u = summarizeUsage(text);
        const ms = modelStats(events);
        out[s.id] = {
          id: s.id, projectRaw: extractProject(text, s.project), updatedAt: s.mtime,
          cwd: extractCwd(text),
          interactive: extractEntrypoint(text) === "cli",
          createdAt: st.firstTs ? new Date(st.firstTs).getTime() : s.mtime,
          lastTs: st.lastTs || null,
          aiTitle: extractAiTitle(text),
          firstPrompt: firstUserPrompt(events),
          stats: {
            durationMs: (st.firstTs && st.lastTs) ? (new Date(st.lastTs) - new Date(st.firstTs)) : 0,
            decisions: st.decisions, files: st.files, commits: st.commits,
            // 레일 3줄째: 대화 N · 에이전트 N · 토큰 · 주 모델
            turns: turnCount(events),
            agents: extractAgents(events, completedAgentIds(text)).length,
            tokens: u.total,
            cost: u.cost,
            model: shortModel((ms.list[0] && ms.list[0].model) || ""),
            family: modelFamily((ms.list[0] && ms.list[0].model) || ""),
          },
          decisions: extractDecisions(events).map((d) => ({ h: d.header, q: d.question, c: d.chosen })),
        };
      } catch {
        out[s.id] = prev || { id: s.id, projectRaw: s.project, updatedAt: s.mtime, createdAt: s.mtime, aiTitle: "", firstPrompt: "", stats: {}, decisions: [] };
      }
    }
    // 프로젝트 해석: 재지정(override) > cwd에서 뽑은 원래값 (재지정은 매번 현재값 반영, 원본 로그 불변)
    out[s.id].projectRaw = out[s.id].projectRaw || s.project;
    out[s.id].project = overrides[s.id] || out[s.id].projectRaw;
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
const VIEWER_PATH = join(__dirname, "public", "viewer.html");
const LIST_PATH = join(__dirname, "public", "list.html");
let VIEWER = await readFile(VIEWER_PATH, "utf8");
let LIST = await readFile(LIST_PATH, "utf8");
// 개발 모드: 매 요청마다 HTML을 다시 읽어 새로고침만으로 반영(핫리로드). 배포 땐 끄고 메모리 캐시 사용.
const DEV = process.env.CW_DEV === "1";

// 브라우저는 요청 출처를 Sec-Fetch-Site 로 알려준다.
//   same-origin = 우리 뷰어 페이지, none = 주소창 직접 입력, cross-site = 다른 사이트가 부름
// 루프백에만 열어놔도 사용자가 방문한 아무 웹페이지가 <img src="http://localhost:4317/export?...">
// 같은 식으로 부를 수 있으므로, 부수효과가 있는 경로는 교차 출처를 거부한다.
function sameOriginOnly(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") return false;
    } catch { return false; }
  }
  return true;
}
const MUTATING = /^\/(export|api\/(rename|setproject|ai|pick-folder))\//;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if ((MUTATING.test(path) || path === "/api/pick-folder") && !sameOriginOnly(req))
    return send(res, 403, "application/json", JSON.stringify({ error: "교차 출처 요청은 허용되지 않습니다" }));

  // 개발 모드면 매 요청마다 뷰어/리스트 HTML을 다시 읽어 즉시 반영(서버 재시작 불필요)
  if (DEV) { VIEWER = await readFile(VIEWER_PATH, "utf8"); LIST = await readFile(LIST_PATH, "utf8"); }

  if (path === "/health") return send(res, 200, "text/plain", "ok");

  // 내보내기 기본 저장 경로(뷰어 다이얼로그 기본값)
  if (path === "/api/export-defaults") {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      dir: join(CW_DIR, "exports"), home: homedir(), canPick: process.platform === "darwin",
    }));
  }

  // 폴더 선택 — 브라우저는 절대 경로를 못 주므로(File System Access API도 핸들만 준다)
  // 로컬 서버가 macOS 네이티브 선택창을 띄우고 POSIX 경로를 돌려준다.
  if (path === "/api/pick-folder") {
    if (process.platform !== "darwin")
      return send(res, 200, "application/json", JSON.stringify({ error: "이 플랫폼에서는 폴더 선택창을 열 수 없습니다" }));
    const start = url.searchParams.get("start") || "";
    return pickFolder(start).then(
      (p) => send(res, 200, "application/json; charset=utf-8", JSON.stringify(p)),
      (e) => send(res, 200, "application/json", JSON.stringify({ error: String(e?.message || e) }))
    );
  }

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

  // 프로젝트 재지정(override) — 영구 저장. 원본 로그는 안 건드리고 매핑만 저장.
  const mProject = path.match(/^\/api\/setproject\/([\w-]+)$/);
  if (mProject) {
    const id = mProject[1];
    const project = (url.searchParams.get("project") || "").slice(0, 80).trim();
    const ov = await readJson(PROJECT_OVERRIDE_PATH, {});
    if (project) ov[id] = project; else delete ov[id];
    await writeJson(PROJECT_OVERRIDE_PATH, ov);
    return send(res, 200, "application/json", JSON.stringify({ ok: true, id, project }));
  }

  // 세션 뷰어 셸 (sessionId 주입)
  const mView = path.match(/^\/s\/([\w-]+)$/);
  if (mView) {
    const html = VIEWER.replace("__SESSION_ID__", mView[1]);
    return send(res, 200, "text/html; charset=utf-8", html);
  }

  // 초기 이벤트(JSON) — 구버전 호환용
  const mApi = path.match(/^\/api\/events\/([\w-]+)$/);
  if (mApi) {
    const file = await pathForSession(mApi[1]);
    if (!file) return send(res, 404, "application/json", JSON.stringify({ error: "session not found" }));
    const events = await eventsForFile(file);
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(events));
  }

  // 세션 전체 페이로드(이벤트 + 집계 + 서브에이전트). 뷰어 첫 로드용.
  const mSess = path.match(/^\/api\/session\/([\w-]+)$/);
  if (mSess) {
    const sessions = await findSessions();
    const sess = sessions.find((s) => s.id === mSess[1]);
    if (!sess) return send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "session not found", id: mSess[1] }));
    try {
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(await sessionPayload(sess)));
    } catch (e) {
      return send(res, 500, "application/json", JSON.stringify({ error: String(e?.message || e) }));
    }
  }

  // SSE 실시간 스트림 (증분 패치)
  const mSse = path.match(/^\/events\/([\w-]+)$/);
  if (mSse) {
    const sessions = await findSessions();
    const sess = sessions.find((s) => s.id === mSse[1]);
    if (!sess) { res.writeHead(404); return res.end(); }
    return startSse(req, res, sess);
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
      const payload = await sessionPayload(sess);
      const events = payload.events;
      const refresh = url.searchParams.get("refresh") === "1";
      const doMask = url.searchParams.get("mask") === "1";
      const cache = {};
      for (const kind of ["summary", "diagram"]) {
        let c = await readCache(id, kind);
        const stale = !c || (c.atEventCount != null && c.atEventCount < events.length);
        if (refresh && stale) {
          try { const out = await runClaude(kind, buildDigest(events)); out.atEventCount = events.length; await writeCache(id, kind, out); c = out; } catch {}
        }
        cache[kind] = (c && c.text) ? c : null;
      }
      // 민감 정보 마스킹 — 체크했을 때만. 원본 로그는 그대로 두고 내보낼 사본에만 적용한다.
      let out = { ...payload, cache };
      let masked = { total: 0, counts: {} };
      if (doMask) {
        const m = maskEvents(payload.events);
        const counts = { ...m.counts };
        out = {
          ...payload,
          events: m.events,
          agg: maskAgg(payload.agg, counts),
          cache: Object.fromEntries(Object.entries(cache).map(([k, v]) =>
            [k, v && v.text ? { ...v, text: maskText(v.text, counts) } : v])),
          masked: true,
        };
        masked = { total: Object.values(counts).reduce((s, n) => s + n, 0), counts };
      }

      // 데이터를 JSON script 태그로 임베드(JS 리터럴이 아니라 JSON.parse로 읽음 → 제어문자/줄바꿈/< 안전).
      // </script> 만 닫힘 방지로 이스케이프.
      const dataJson = JSON.stringify(out).replace(/<\/script>/gi, "<\\/script>");
      const inject = `<script type="application/json" id="cw-export-data">${dataJson}</script>`;
      // ⚠️ 치환문자열에 데이터($ 포함)를 직접 넣으면 $&·$' 등이 특수 치환으로 해석됨 → 함수 치환으로 회피
      const html = VIEWER.replace("__SESSION_ID__", () => id).replace("</head>", () => inject + "\n</head>");

      // 저장 위치·파일명: 사용자가 지정할 수 있고, 비우면 기본값을 쓴다.
      const clean = (s) => String(s).replace(/[\/\\:*?"<>|\n\r]+/g, " ").trim();
      const titleSrc = (events.find((e) => e.kind === "user_text" && e.text && !e.text.startsWith("[")) || {}).text || "session";
      const d = new Date();
      const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
      const proj = clean((sess.project || "").split("/").pop() || "session");
      const defName = `[${ymd}] ${proj} · ${clean(titleSrc.split("\n")[0]).slice(0, 40)}`;

      let fname = clean(url.searchParams.get("name") || "") || defName;
      if (!/\.html?$/i.test(fname)) fname += ".html";

      const rawDir = (url.searchParams.get("dir") || "").trim();
      const dir = rawDir
        ? (rawDir.startsWith("~") ? join(homedir(), rawDir.slice(1)) : rawDir)
        : join(CW_DIR, "exports");
      await mkdir(dir, { recursive: true });
      const fpath = join(dir, fname);
      await writeFile(fpath, html, "utf8");
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        ok: true, file: fname, dir, path: fpath,
        hasAI: { summary: !!cache.summary, diagram: !!cache.diagram },
        masked: doMask ? masked : null,
      }));
    } catch (e) {
      return send(res, 500, "application/json", JSON.stringify({ error: String(e?.message || e) }));
    }
  }

  send(res, 404, "text/plain", "not found");
});

// macOS 네이티브 폴더 선택창. 취소하면 osascript가 1로 끝나므로 canceled 로 구분한다.
function pickFolder(start) {
  return new Promise((resolve, reject) => {
    const args = ["-e", 'tell application "System Events" to activate'];
    const target = start && start.startsWith("/") ? `default location POSIX file ${JSON.stringify(start)} ` : "";
    args.push("-e", `POSIX path of (choose folder with prompt "내보낼 폴더를 선택하세요" ${target})`);
    const child = spawn("osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) return resolve({ dir: out.trim().replace(/\/$/, "") });
      if (/User canceled/i.test(err)) return resolve({ canceled: true });
      reject(new Error(err.trim() || `osascript exited ${code}`));
    });
  });
}

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

// SSE: 파일이 바뀔 때 '달라진 뒷부분만' 보낸다.
//   예전에는 변경 1줄마다 전체 스냅샷(12MB 세션 = 4.6MB)을 다시 밀어 화면 전체가 재생성됐다.
//   이제 이전에 보낸 이벤트와 비교해 처음으로 달라지는 지점(from)부터만 전송한다.
//   tool_result가 나중에 붙어 앞쪽 이벤트가 갱신되는 경우도 같은 규칙으로 자연스럽게 처리된다.
function startSse(req, res, sess) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  let sent = [];      // 지금까지 보낸 이벤트의 직렬화 문자열
  let first = true;

  const push = async () => {
    if (closed) return;
    try {
      const payload = await sessionPayload(sess);
      const next = payload.events.map((e) => JSON.stringify(e));

      if (first) {
        first = false;
        sent = next;
        res.write(`event: init\ndata: ${JSON.stringify(payload)}\n\n`);
        return;
      }

      let from = 0;
      while (from < next.length && from < sent.length && next[from] === sent[from]) from++;
      const changed = from < next.length || next.length !== sent.length;
      sent = next;
      if (!changed) return;

      // 뒷부분 이벤트 + 갱신된 집계/usage만 전송 (집계는 작고, 이벤트 본문이 컸다)
      res.write(`event: patch\ndata: ${JSON.stringify({
        from,
        total: next.length,
        events: payload.events.slice(from),
        usage: payload.usage,
        agg: payload.agg,
      })}\n\n`);
    } catch { /* 파일 일시적 읽기 실패는 무시 */ }
  };

  push(); // 최초 전체 전송

  let timer = null;
  let watcher;
  try {
    watcher = watch(sess.path, () => {
      clearTimeout(timer);
      timer = setTimeout(push, 150); // 잦은 append를 묶음
    });
  } catch { /* watch 실패 시 최초 전송만 제공 */ }

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
  // 요약 탭의 '한 줄 결론 + 불릿 3개' 형태에 맞춰 JSON으로 받는다.
  summary:
    "다음은 Claude Code 코딩 세션의 작업 기록이다. 한국어로 요약하되 아래 JSON만 출력하라(코드펜스·설명 금지).\n" +
    '{"headline":"이 세션이 결국 무엇을 했는지 한 문장(60자 내외, 명사형 종결 금지)",' +
    '"bullets":["왜/무엇을 바꿨는지 한 문장","두 번째","세 번째"]}\n' +
    "불릿은 정확히 3개. 파일명·함수명은 그대로 쓰고 군더더기 금지.\n" +
    "첫 글자는 반드시 { 여야 한다. 인사말·설명·코드펜스를 앞뒤에 붙이지 마라.\n\n",
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

server.listen(PORT, HOST, () => {
  console.log(`claude-watch listening on http://localhost:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost")
    console.log(`⚠️  CW_HOST=${HOST} — 세션 전문이 네트워크에 공개됩니다. 인증이 없으니 신뢰하는 망에서만 쓰세요.`);
});
