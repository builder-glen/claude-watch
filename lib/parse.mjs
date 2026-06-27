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

// JSONL 전체 텍스트 → 정규화된 이벤트 배열
export function parseTranscript(text) {
  const raw = [];           // 순서 보존용 이벤트(아직 tool_result 미병합)
  const resultsById = {};   // tool_use_id → {text, isError}

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
      raw.push({ kind: "user_text", text: content, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      switch (c.type) {
        case "text":
          raw.push({
            kind: type === "user" ? "user_text" : "assistant_text",
            text: c.text || "",
            ts,
          });
          break;
        case "thinking":
          if ((c.thinking || "").trim())
            raw.push({ kind: "thinking", text: c.thinking, ts });
          break;
        case "tool_use":
          raw.push({
            kind: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input || {},
            ts,
          });
          break;
        case "tool_result":
          resultsById[c.tool_use_id] = {
            text: flattenResult(c.content),
            isError: c.is_error === true,
          };
          break;
        case "image":
          raw.push({ kind: "image", ts });
          break;
        default:
          break; // 모르는 블록은 버림
      }
    }
  }

  // tool_use에 결과 병합, 독립 tool_result 줄은 제거
  const events = [];
  for (const e of raw) {
    if (e.kind === "tool_use") {
      const r = resultsById[e.id];
      events.push({ ...e, result: r ? r.text : null, isError: r ? r.isError : false });
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
  return PRICE.sonnet; // 기본/sonnet
}

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
      out.push({ header: q.header || "", question: q.question || "", chosen: chosen[q.question] || "" });
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
