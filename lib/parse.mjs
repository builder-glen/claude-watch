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
