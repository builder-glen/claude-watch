// Claude Code 세션 JSONL(한 줄=한 이벤트)을 사람이 읽기 좋은 이벤트 배열로 정규화한다.
// 핵심 규칙:
//  - assistant 줄의 message.content[] 안에 text / thinking / tool_use 블록이 들어있다.
//  - user 줄의 content[] 안에 tool_result / text / image 가 들어있다.
//  - tool_use(요청)와 tool_result(결과)는 별도 줄이며 id ↔ tool_use_id 로 짝지어 한 카드로 합친다.
//  - 모르는 형식/노이즈(mode·system·attachment 등)는 조용히 버린다(방어적 파싱).

// tool_result content를 사람이 읽을 문자열로 평탄화
function flattenResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          if (typeof c.text === "string") return c.text;
          return JSON.stringify(c);
        }
        return "";
      })
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

// 시스템/하네스가 자동 주입한 user 메시지(사람이 친 게 아님) 감지.
//  - 슬래시 명령/로컬 명령 래퍼 태그(<command-*>, <local-command-*>, <bash-*>, <system-reminder>)
//  - 로컬 명령 caveat 안내문 · 도구 호출 오류 · 인터럽트 알림
// ※ 반드시 '문자열 시작' 기준으로만 판정 — 사용자가 이 문구를 인용/붙여넣기 한 경우 오분류 방지.
const SYS_NOTE_RE = /^\s*(?:<(?:local-command-|command-|bash-|system-reminder)|Caveat: The messages below were generated|Your tool call was malformed|API Error|\[Request interrupted)/;
// 스킬 로딩 주입: 하네스가 스킬 문서 전문을 user 메시지로 밀어넣는다(사용자 발화가 아님).
const SKILL_RE = /^\s*Base directory for this skill:\s*(\S+)/;

// 하네스는 자동 주입한 user 라인에 isMeta:true 를 붙인다. 실제 사용자 입력에는 붙지 않는다.
// 문구 패턴보다 이게 확실한 신호다 — 스킬 본문처럼 아무 머리말 없이 들어오는 주입도 잡힌다.
// (문구 정규식은 isMeta 가 없던 구버전 로그를 위한 보조 판정으로 남긴다)
// 주입된 스킬 이름. 머리말이 있으면 경로에서 뽑고, 없으면 직전에 호출된 Skill 도구의 인자를 쓴다.
//   (/artifact-design 처럼 본문만 밀려 들어오는 스킬은 머리말이 없다)
let lastSkillCalled = "";
function skillOf(o, text) {
  const named = skillNameOf(text);
  if (named) { lastSkillCalled = ""; return named; }
  if (o.isMeta === true && lastSkillCalled) {
    const s = lastSkillCalled;
    lastSkillCalled = "";     // 한 호출당 한 번만 귀속(이후 주입은 일반 SYS)
    return s;
  }
  return "";
}

function userKind(text, isMeta, skill) {
  const s = String(text || "");
  if (SKILL_RE.test(s)) return "skill_note";
  // 스킬 호출 직후 들어온 주입이면 머리말이 없어도 스킬 노트로 본다
  if (isMeta === true) return skill ? "skill_note" : "system_note";
  return SYS_NOTE_RE.test(s) ? "system_note" : "user_text";
}

// 주입된 스킬 경로 → 스킬 이름(마지막 경로 조각)
export function skillNameOf(text) {
  const m = SKILL_RE.exec(String(text || ""));
  if (!m) return "";
  return m[1].split("/").filter(Boolean).pop() || "";
}

// 토큰 대략 추정(주입량 표시용). 정확한 값이 아니라 자릿수 감각용.
const estTokens = (s) => Math.round(String(s || "").length / 3.6);

// toolUseResult에는 프롬프트 전문·결과 본문까지 들어있다.
// 서브에이전트 표시에 쓰는 필드만 남겨 이벤트 페이로드가 부풀지 않게 한다.
function agentMeta(r) {
  if (!r || typeof r !== "object") return null;
  if (!r.agentId && !r.agentType) return null;
  return {
    agentId: r.agentId || "",
    agentType: r.agentType || "",
    status: r.status || "",
    resolvedModel: r.resolvedModel || "",
    totalDurationMs: r.totalDurationMs ?? null,
    totalTokens: r.totalTokens ?? null,
    totalToolUseCount: r.totalToolUseCount ?? null,
    toolStats: r.toolStats || null,
    description: r.description || "",
  };
}

// JSONL 전체 텍스트 → 정규화된 이벤트 배열
export function parseTranscript(text) {
  const raw = [];           // 순서 보존용 이벤트(아직 tool_result 미병합)
  const resultsById = {};   // tool_use_id → {text, isError, meta}
  let anchor = 0;           // 메시지 단위 앵커 번호(#m1, #m2 …) — 링크 공유용
  let lastMsgId = null;     // 같은 messageId의 블록은 한 메시지로 묶어 앵커 공유
  lastSkillCalled = "";

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }

    const type = o.type;
    const ts = o.timestamp || null;
    const msg = o.message && typeof o.message === "object" ? o.message : null;
    if (!msg) continue;

    const content = msg.content;

    // user 메시지의 content가 문자열인 경우(순수 사용자 입력)
    if (type === "user" && typeof content === "string") {
      const sk1 = skillOf(o, content);
      raw.push({ kind: userKind(content, o.isMeta, sk1), text: content, ts, m: ++anchor, skill: sk1 });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // user 메시지: 한 메시지의 텍스트+첨부이미지를 '한 버블'로 병합(각각 분리 방지).
    //  tool_result 블록은 버블이 아니라 결과 매칭용이라 따로 저장.
    //  ※ toolUseResult(같은 줄의 최상위 필드)에 서브에이전트 실행 요약이 들어온다 → meta로 보관.
    if (type === "user") {
      let text = "", imgs = 0;
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text") text += (text ? "\n" : "") + (c.text || "");
        else if (c.type === "image") imgs++;
        else if (c.type === "tool_result")
          resultsById[c.tool_use_id] = {
            text: flattenResult(c.content),
            isError: c.is_error === true,
            meta: agentMeta(o.toolUseResult),
          };
      }
      if (text || imgs) {
        const sk = skillOf(o, text);
        raw.push({ kind: userKind(text, o.isMeta, sk), text, ts, images: imgs, m: ++anchor, skill: sk });
      }
      continue;
    }

    // assistant 메시지: text / thinking / tool_use 를 각각 이벤트로.
    //  model/usage는 메시지 단위 값이므로 블록마다 함께 실어 보낸다(모델 칩·전환 마커·비용에 쓰임).
    const msgId = o.messageId || msg.id || null;
    if (!msgId || msgId !== lastMsgId) { anchor++; lastMsgId = msgId; }
    const model = msg.model || "";
    // usage 원본은 iterations 등으로 커서 그대로 실으면 페이로드가 부푼다 → 쓰는 4개 값만 압축해 싣는다.
    const u = msg.usage;
    const usage = u ? {
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
    } : null;
    let usageAttached = false;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      // 같은 메시지의 첫 블록에만 usage를 붙인다(블록마다 중복 = 중복 합산 위험 + 용량 낭비)
      const base = { ts, m: anchor, model, effort: o.effort || "" };
      if (usage && !usageAttached) { base.usage = usage; usageAttached = true; }
      switch (c.type) {
        case "text":
          raw.push({ kind: "assistant_text", text: c.text || "", ...base });
          break;
        case "thinking":
          if ((c.thinking || "").trim())
            raw.push({ kind: "thinking", text: c.thinking, ...base });
          break;
        case "tool_use":
          if (c.name === "Skill" && c.input && c.input.skill) lastSkillCalled = String(c.input.skill);
          raw.push({ kind: "tool_use", id: c.id, name: c.name, input: c.input || {}, ...base });
          break;
        default:
          break; // 모르는 블록은 버림
      }
    }
  }

  // "[Image: source: /path]" 같이 이미지 경로만 있는 user 메시지인가?
  const isImgMeta = (t) => {
    const lines = String(t || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.length > 0 && lines.every((l) => l.startsWith("[Image:"));
  };

  // tool_use에 결과 병합 · 독립 tool_result 제거 · 이미지경로 메타는 직전 user 버블로 흡수
  const events = [];
  for (const e of raw) {
    if (e.kind === "tool_use") {
      const r = resultsById[e.id];
      events.push({ ...e, result: r ? r.text : null, isError: r ? r.isError : false, meta: r ? r.meta : null });
      // 이미지 경로 메타에도 isMeta:true 가 붙어 system_note 로 분류된다.
      // 이건 SYS 노트로 보여줄 게 아니라 직전 사용자 버블의 첨부로 흡수해야 한다.
    } else if ((e.kind === "user_text" || e.kind === "system_note") && isImgMeta(e.text)) {
      // 파일명 추출 → 직전 user 버블에 첨부로 붙임. 파일명 없는 메타(스크린샷 치수 등)는 노이즈로 버림.
      const names = [...e.text.matchAll(/([^/\s\]]+\.(?:png|jpe?g|gif|webp|svg))/gi)].map((m) => m[1]);
      if (names.length) {
        const prev = [...events].reverse().find((x) => x.kind === "user_text");
        if (prev) prev.imageNames = (prev.imageNames || []).concat(names);
        else events.push(e);
      }
    } else {
      events.push(e);
    }
  }
  return events;
}

// 모델별 추정 단가(토큰당 USD): [입력, 출력, 캐시생성, 캐시읽기]
// ※ API 종량제 기준 추정치. 구독제(Max/Pro)면 실제 청구액이 아니라 "API 환산" 값.
const PRICE = {
  opus:   { in: 15e-6, out: 75e-6, cw: 18.75e-6, cr: 1.5e-6 },
  sonnet: { in: 3e-6,  out: 15e-6, cw: 3.75e-6,  cr: 0.3e-6 },
  haiku:  { in: 1e-6,  out: 5e-6,  cw: 1.25e-6,  cr: 0.1e-6 },
};
function priceFor(model) {
  const m = String(model || "");
  if (m.includes("opus")) return PRICE.opus;
  if (m.includes("haiku")) return PRICE.haiku;
  // fable: 공개 단가를 확인하지 못해 sonnet 티어로 계산한다(정확한 단가 확인되면 PRICE에 추가할 것).
  return PRICE.sonnet; // 기본/sonnet/fable
}

// 모델 id → UI 색 키(opus/sonnet/haiku/기타). 뷰어의 모델 칩·비율 바가 이 값을 쓴다.
export function modelFamily(model) {
  const m = String(model || "");
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("fable")) return "fable";
  return "other";
}

// 모델 id를 화면용 짧은 이름으로 (claude-opus-5 → opus-5)
export function shortModel(model) {
  return String(model || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// <synthetic>은 모델이 아니라 시스템 알림(로그인 만료·API 오류)이다 → 모델 통계에서 제외.
const isRealModel = (m) => !!m && m !== "<synthetic>";

// ── 색인용 추출기들 (목록·검색에 쓰임, 토큰 0) ──────────────
// AskUserQuestion → 의사결정 목록 [{header, question, chosen}]
export function extractDecisions(events) {
  const out = [];
  for (const e of events) {
    if (e.kind !== "tool_use" || e.name !== "AskUserQuestion") continue;
    const chosen = {};
    const re = /"([^"]+)"\s*=\s*"([^"]+)"/g; let m;
    while ((m = re.exec(String(e.result || "")))) chosen[m[1]] = m[2];
    for (const q of (e.input?.questions || [])) {
      // m 은 대화 탭의 앵커 번호. 요약에서 이 결정이 오간 지점으로 바로 갈 수 있게 함께 넘긴다.
      out.push({ header: q.header || "", question: q.question || "", chosen: chosen[q.question] || "", m: e.m });
    }
  }
  return out;
}

// 세션 통계: 시작/끝 시각, 결정수, 변경파일수, 커밋수
export function sessionStats(events) {
  let firstTs = null, lastTs = null, decisions = 0, commits = 0;
  const files = new Set();
  for (const e of events) {
    if (e.ts) { firstTs = firstTs || e.ts; lastTs = e.ts; }
    if (e.kind !== "tool_use") continue;
    if (e.name === "AskUserQuestion") decisions += (e.input?.questions || []).length;
    if (e.name === "Bash" && /git commit/.test(e.input?.command || "")) commits++;
    const f = e.input?.file_path;
    if (f && (e.name === "Edit" || e.name === "Write")) files.add(f);
  }
  return { firstTs, lastTs, decisions, files: files.size, commits };
}

// ── 요약 탭 집계 (전부 토큰 0, 이미 기록된 데이터만 사용) ──────

// 주입된 스킬 목록 [{name, tokens, count}]
export function extractSkills(events) {
  const by = new Map();
  for (const e of events) {
    if (e.kind !== "skill_note") continue;
    // e.skill 은 파싱 때 붙여둔 귀속 이름 — 머리말 없는 주입은 여기에만 있다
    const name = e.skill || skillNameOf(e.text) || "(이름 불명)";
    const prev = by.get(name) || { name, tokens: 0, count: 0 };
    prev.tokens += estTokens(e.text);
    prev.count++;
    by.set(name, prev);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens);
}

// 도구별 호출 수 [{name, count}] + 실패 수. 서브에이전트 호출(Task/Agent)도 한 도구로 센다.
export function toolStats(events) {
  const by = new Map();
  let fails = 0, total = 0;
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    total++;
    if (e.isError) fails++;
    by.set(e.name, (by.get(e.name) || 0) + 1);
  }
  const list = [...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return { list, fails, total };
}

// 서브에이전트 목록. 부모 로그의 toolUseResult에 실행 요약이 이미 들어있어 추가 I/O가 필요 없다.
//  status: completed | async_launched(진행 중으로 표시) | 기타
// 백그라운드(비동기) 에이전트의 완료 신호는 대화 본문이 아니라
// queue-operation / attachment 같은 부가 라인의 <task-notification> 안에 들어온다.
// 이 라인들은 이벤트로 정규화되지 않으므로 원본 JSONL에서 직접 훑는다.
export function completedAgentIds(text) {
  const done = new Set();
  const src = String(text || "");
  for (const m of src.matchAll(/<task-id>([^<\\"]+)<\\?\/task-id>/g)) done.add(m[1]);
  for (const m of src.matchAll(/<tool-use-id>([^<\\"]+)<\\?\/tool-use-id>/g)) done.add(m[1]);
  return done;
}

export function extractAgents(events, doneIds) {
  const done = doneIds || new Set();
  const out = [];
  for (const e of events) {
    if (e.kind !== "tool_use" || !/^(Task|Agent)$/.test(e.name || "")) continue;
    const meta = e.meta || {};
    const running = meta.status === "async_launched"
      ? !(done.has(e.id) || done.has(meta.agentId))
      : (!meta.status && e.result == null);
    out.push({
      n: out.length + 1,
      id: meta.agentId || e.id,
      desc: e.input?.description || meta.description || "(설명 없음)",
      type: e.input?.subagent_type || meta.agentType || "",
      model: meta.resolvedModel || "",
      tools: meta.totalToolUseCount ?? null,
      tokens: meta.totalTokens ?? null,
      durationMs: meta.totalDurationMs ?? null,
      toolStats: meta.toolStats || null,
      running,
      status: running ? "진행" : "완료",
      ts: e.ts || null,
      m: e.m,
    });
  }
  return out;
}

// 모델별 토큰/비용 + 전환 지점. text(원본 JSONL)가 아니라 events를 쓴다(모델이 이벤트에 실려 있음).
export function modelStats(events) {
  const by = new Map();
  const switches = [];
  let last = null;
  const seenMsg = new Set();
  for (const e of events) {
    if (!isRealModel(e.model)) continue;
    // 같은 메시지의 블록이 여러 개 → usage 중복 합산 방지
    if (e.usage && !seenMsg.has(e.m)) {
      seenMsg.add(e.m);
      const u = e.usage;
      const i = u.in || 0, out = u.out || 0, cw = u.cw || 0, cr = u.cr || 0;
      const p = priceFor(e.model);
      const prev = by.get(e.model) || { model: e.model, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0 };
      prev.input += i; prev.output += out; prev.cacheCreate += cw; prev.cacheRead += cr;
      prev.total += i + out + cw + cr;
      prev.cost += i * p.in + out * p.out + cw * p.cw + cr * p.cr;
      by.set(e.model, prev);
    }
    if (last && last !== e.model) switches.push({ from: last, to: e.model, ts: e.ts, m: e.m });
    last = e.model;
  }
  const list = [...by.values()].sort((a, b) => b.total - a.total);
  return { list, switches, current: last || "", count: list.length };
}

// 파일 변경 목록 [{path, kind:'new'|'mod'|'del', add, del, hunks:[{sign,text}]}]
//  Write=생성, Edit=수정, Bash의 rm=삭제. 같은 파일 반복 수정은 누적한다.
export function fileChanges(events) {
  const by = new Map();
  const get = (p) => {
    let f = by.get(p);
    if (!f) { f = { path: p, kind: "mod", add: 0, del: 0, hunks: [], touches: 0 }; by.set(p, f); }
    return f;
  };
  const lines = (s) => String(s || "").split("\n");
  const countLines = (s) => (s == null || s === "" ? 0 : lines(s).length);
  // 파일당 diff 본문은 상한을 둔다 — 한 파일을 수십 번 고친 세션에서 페이로드가 폭주하지 않게.
  const HUNK_CAP = 400;
  const push = (f, sign, arr) => {
    for (const l of arr) {
      if (f.hunks.length >= HUNK_CAP) { f.clipped = true; return; }
      f.hunks.push({ sign, text: l });
    }
  };

  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    const p = e.input?.file_path;
    if (e.name === "Write" && p) {
      const f = get(p);
      f.kind = "new"; f.touches++;
      f.add += countLines(e.input.content);
      push(f, "+", lines(e.input.content));
    } else if (e.name === "Edit" && p) {
      const f = get(p);
      if (f.kind !== "new") f.kind = "mod";
      f.touches++;
      f.del += countLines(e.input.old_string);
      f.add += countLines(e.input.new_string);
      push(f, "-", lines(e.input.old_string));
      push(f, "+", lines(e.input.new_string));
    } else if (e.name === "Bash") {
      // rm 으로 지운 파일 — 옵션 플래그는 건너뛰고 경로만 취한다.
      const cmd = String(e.input?.command || "");
      const m = /(?:^|[;&|]\s*)rm\s+((?:-\w+\s+)*)([^\s;&|]+)/.exec(cmd);
      if (m && !/\*/.test(m[2])) {
        const f = get(m[2]);
        if (f.touches === 0) { f.kind = "del"; f.touches++; }
      }
    }
  }
  const order = { new: 0, mod: 1, del: 2 };
  return [...by.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || b.touches - a.touches);
}

// 주고받은 대화 수 = 사용자가 실제로 친 메시지 수(스킬/시스템 주입 제외)
export function turnCount(events) {
  return events.filter((e) => e.kind === "user_text").length;
}

// 첫 사용자 질문 한 줄 (제목 폴백)
export function firstUserPrompt(events) {
  const e = events.find((x) => x.kind === "user_text" && x.text && !x.text.startsWith("[") && x.text.length < 2000);
  return e ? e.text.split("\n")[0].slice(0, 80).trim() : "";
}

// 세션 JSONL에 이미 기록된 usage를 합산한다(모델 호출 없음 = 토큰 0).
export function summarizeUsage(text) {
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type !== "assistant") continue;
    const u = o.message && o.message.usage;
    if (!u) continue;
    const i = u.input_tokens || 0, out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    input += i; output += out; cacheCreate += cw; cacheRead += cr;
    const p = priceFor(o.message.model);
    cost += i * p.in + out * p.out + cw * p.cw + cr * p.cr;
  }
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead, cost };
}
