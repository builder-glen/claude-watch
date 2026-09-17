#!/usr/bin/env node
// claude-watch CLI — 의존성 0. npm 의 bin 진입점이자 예전 bash `cw` 의 대체.
//   claude-watch            서버를 띄우고(이미 떠 있으면 그대로) 목록 페이지를 연다
//   claude-watch history    최근 세션 목록
//   claude-watch open <n>   n번 세션을 브라우저로
//   claude-watch resume <n> n번 세션을 터미널 새 탭에서 이어간다(--copy 는 명령만 출력)
//   claude-watch setup      Claude Code statusLine 에 뷰어 링크 + 서버 자동 기동 등록

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CW_DIR = process.env.CW_HOME || join(homedir(), ".claude-watch");
const PORT = Number(process.env.CW_PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const LAST = join(CW_DIR, ".last-list");
// 테스트가 실제 설정을 건드리지 않도록 env 로 바꿀 수 있다.
const SETTINGS = process.env.CW_CLAUDE_SETTINGS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

const alive = async () => { try { return (await fetch(BASE + "/health", { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

const VERSION = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
const killServer = () => new Promise((r) => spawn("sh", ["-c", `lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill`], { stdio: "ignore" }).on("close", r).on("error", r));

async function ensureServer() {
  if (await alive()) {
    // 서버는 분리 기동돼 오래 산다 — 업데이트 뒤에도 옛 코드가 돌고 있으면 새 기능이 조용히 안 보인다.
    let running = null;
    try { const r = await fetch(BASE + "/api/version", { signal: AbortSignal.timeout(1500) }); if (r.ok) running = (await r.json()).version; } catch {}
    if (running === VERSION) return;
    console.log(`떠 있는 서버(${running || "구버전"})를 ${VERSION} 로 다시 띄웁니다…`);
    await killServer();
    for (let i = 0; i < 20 && (await alive()); i++) await new Promise((r) => setTimeout(r, 150));
  }
  // 터미널을 닫아도 살아 있도록 분리해서 띄운다(statusline.sh 의 자동 기동과 같은 방식).
  spawn(process.execPath, [join(ROOT, "server.mjs")], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40; i++) { if (await alive()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`서버가 뜨지 않았어요 (${BASE}). 포트를 다른 프로그램이 쓰고 있는지 확인해 주세요.`);
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  console.log(url);
}

const rel = (ms) => {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000, m = s / 60, h = m / 60, d = h / 24;
  return s < 60 ? "방금" : m < 60 ? `${Math.floor(m)}분전` : h < 24 ? `${Math.floor(h)}시간전` : d < 7 ? `${Math.floor(d)}일전` : new Date(ms).toISOString().slice(0, 10);
};

async function idOf(n) {
  const ids = (await readFile(LAST, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const id = ids[Number(n) - 1];
  if (!id) throw new Error(`번호 ${n ?? ""} 없음 — 먼저 'claude-watch history' 를 실행해 주세요.`);
  return id;
}

const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

const commands = {
  async start() { await ensureServer(); openBrowser(BASE + "/"); },
  async web() { await ensureServer(); openBrowser(BASE + "/"); },

  async history() {
    await ensureServer();
    const all = (await (await fetch(BASE + "/api/index")).json()).filter((x) => x.interactive)   // 사람(cli) 세션만
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await mkdir(CW_DIR, { recursive: true });
    await writeFile(LAST, all.map((x) => x.id).join("\n"));
    all.slice(0, 30).forEach((x, i) => {
      const st = x.stats || {};
      const tags = [st.decisions ? `⚖${st.decisions}` : "", st.files ? `📝${st.files}` : "", x.archived ? "보관본" : ""].filter(Boolean).join(" ");
      console.log(`${String(i + 1).padStart(2)}. [${(x.project || "").split("/").pop()}] ${(x.title || "").slice(0, 46)}  ${rel(x.createdAt)} ${tags}`);
    });
    if (all.length > 30) console.log(`   … 외 ${all.length - 30}개 (전체는 목록 페이지)`);
    console.log(`\n🦞 전체 목록 → ${BASE}/`);
    console.log(`   open <n> 열기 · resume <n> 이어하기 · rename <n> "제목" · project <n> "이름"`);
  },

  async open(n) { await ensureServer(); openBrowser(`${BASE}/s/${await idOf(n)}`); },

  async resume(n, flag) {
    await ensureServer();
    const id = await idOf(n);
    const row = (await (await fetch(BASE + "/api/index")).json()).find((x) => x.id === id) || {};
    const cmd = (row.cwd ? `cd ${shq(row.cwd)} && ` : "") + `claude --resume ${id}`;
    if (flag === "--copy") return console.log(cmd);
    const d = await (await fetch(`${BASE}/api/resume-terminal?id=${id}`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } })).json();
    if (d.error) { console.log(`터미널을 열지 못했어요: ${d.error}\n직접 실행: ${cmd}`); process.exitCode = 1; }
    else console.log(`✓ ${d.app} 에서 세션을 열었어요.`);
  },

  async rename(n, ...t) {
    await ensureServer();
    const title = t.join(" ");
    await fetch(`${BASE}/api/rename/${await idOf(n)}?title=${encodeURIComponent(title)}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    console.log(`✓ #${n} 제목 변경: ${title}`);
  },

  async project(n, ...t) {
    await ensureServer();
    const proj = t.join(" ");
    await fetch(`${BASE}/api/setproject/${await idOf(n)}?project=${encodeURIComponent(proj)}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    console.log(`✓ #${n} 프로젝트 재지정: ${proj || "(해제)"}`);
  },

  // Claude Code 의 statusLine 에 등록하면 터미널 하단에 현재 세션 뷰어 링크가 뜨고 서버가 자동으로 뜬다.
  async setup(flag) {
    const script = join(ROOT, "bin", "statusline.sh");
    // npx 로 실행하면 패키지가 임시 캐시에 있어, 캐시가 비워지는 순간 statusLine 이 깨진다.
    if (/[\\/]_npx[\\/]/.test(ROOT)) {
      console.log("npx 로 실행 중이라 설치 경로가 임시 폴더예요. statusLine 등록은 전역 설치 후에 해주세요:\n  npm i -g @builder-glen/claude-watch && claude-watch setup");
      process.exitCode = 1; return;
    }
    let cfg = {};
    try { cfg = JSON.parse(await readFile(SETTINGS, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error(`${SETTINGS} 을 읽지 못했어요: ${e.message}`); }
    const want = `bash ${shq(script)}`;
    const cur = cfg.statusLine && cfg.statusLine.command;
    if (cur && cur.includes("claude-watch") && cur.includes(script)) return console.log("✓ 이미 등록되어 있어요.");
    if (cur && !cur.includes("claude-watch") && flag !== "--force") {
      console.log(`이미 다른 statusLine 이 있어요:\n  ${cur}\n바꾸려면: claude-watch setup --force\n  기존 statusLine 은 대체됩니다(claude-hud 를 쓰고 있다면 그 출력은 그대로 이어 붙여 유지). 되돌리기: claude-watch unsetup`);
      process.exitCode = 1; return;
    }
    await mkdir(dirname(SETTINGS), { recursive: true });
    const hadFile = Object.keys(cfg).length > 0;
    // 되돌릴 수 있게 백업 — 처음 한 번만. 다시 돌릴 때 덮어쓰면 "원래 설정"이 사라진다.
    const BAK = SETTINGS + ".claude-watch.bak";
    if (hadFile && !(await readFile(BAK, "utf8").then(() => true, () => false))) await copyFile(SETTINGS, BAK);
    cfg.statusLine = { type: "command", command: want };
    await writeFile(SETTINGS, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`✓ statusLine 등록 완료 — Claude Code 를 다시 시작하면 터미널 하단에 뷰어 링크가 떠요.${hadFile ? `\n  (백업: ${SETTINGS}.claude-watch.bak)` : ""}`);
  },

  // setup 을 되돌린다. npm uninstall 전에 돌리지 않으면 statusLine 이 없는 스크립트를 가리킨 채 남는다.
  async unsetup() {
    let cfg;
    try { cfg = JSON.parse(await readFile(SETTINGS, "utf8")); } catch { return console.log("설정 파일이 없어요 — 되돌릴 것이 없습니다."); }
    const cur = cfg.statusLine && cfg.statusLine.command;
    if (!cur || !cur.includes("claude-watch")) return console.log("claude-watch 의 statusLine 이 등록돼 있지 않아요.");
    let before = null;
    try { before = JSON.parse(await readFile(SETTINGS + ".claude-watch.bak", "utf8")).statusLine || null; } catch {}
    if (before && !String(before.command || "").includes("claude-watch")) cfg.statusLine = before; else delete cfg.statusLine;
    await writeFile(SETTINGS, JSON.stringify(cfg, null, 2) + "\n");
    console.log(before && cfg.statusLine ? `✓ 예전 statusLine 으로 되돌렸어요: ${cfg.statusLine.command}` : "✓ statusLine 등록을 지웠어요.");
  },

  async stop() {
    if (!(await alive())) return console.log("서버가 떠 있지 않아요.");
    await killServer();
    console.log("✓ 서버를 종료했어요.");
  },

  help() {
    console.log(`claude-watch — AI 작업 세션을 보고서로

  claude-watch              서버 실행 + 세션 목록 열기 (${BASE})
  claude-watch history      최근 세션 목록
  claude-watch open <n>     n번 세션 열기
  claude-watch resume <n>   n번 세션을 터미널에서 이어가기 (--copy: 명령만 출력)
  claude-watch rename <n> "제목"
  claude-watch project <n> "프로젝트명"
  claude-watch setup        Claude Code statusLine 등록 (링크 + 서버 자동 기동)
  claude-watch unsetup      setup 되돌리기
  claude-watch stop         서버 종료

  환경변수: CW_PORT(기본 4317) · CW_HOME(기본 ~/.claude-watch)`);
  },
};

const [cmd = "start", ...args] = process.argv.slice(2);
const run = commands[cmd === "-h" || cmd === "--help" ? "help" : cmd];
if (!run) { commands.help(); process.exitCode = 1; }
else Promise.resolve().then(() => run(...args)).catch((e) => { console.error(e.message || e); process.exitCode = 1; });
