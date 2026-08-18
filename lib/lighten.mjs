// 내보낸 HTML 경량화 — 원본 로그는 건드리지 않고 내보낼 사본만 줄인다.
//
// 왜 필요한가: 세션 파일의 대부분은 사람이 읽는 대화가 아니라 도구 실행 결과 본문이다.
// 실측(831 이벤트 · 6.95MB) 기준 구성 —
//   tool_use.result 80.4% · tool_use.input 9.8% · skill_note.text 2.1% · 나머지 합쳐 7.7%
// 메신저로 보낼 수 있는 크기로 줄이려면 결과 본문을 자르는 것 외에 방법이 없다.
//
// 잘린 자리에는 반드시 표시를 남긴다. 뷰어에 '접힌 도구 펼치기'가 있어서, 표시가 없으면
// 펼쳤을 때 내용이 왜 짧은지 알 수 없다.

// 뷰어는 도구 결과를 6000자까지만 그린다(viewer.html 의 tdetail).
// 그 뒤는 어떤 모드에서도 화면에 나오지 않으므로, 잘라도 보이는 것이 달라지지 않는다.
export const VIEWER_RESULT_LIMIT = 6000;

const CAPS = {
  // 보이는 것이 전혀 달라지지 않는 선. 기본 내보내기에 적용한다.
  full: { result: VIEWER_RESULT_LIMIT, input: null, note: null },
  // 남에게 보내는 용도. 도구 결과는 "무엇을 했는지" 알아볼 만큼만 남긴다.
  light: { result: 800, input: 400, note: 600 },
};

function cut(text, cap, counts, key) {
  if (typeof text !== "string" || cap == null || text.length <= cap) return text;
  counts[key] = (counts[key] || 0) + 1;
  counts.savedChars = (counts.savedChars || 0) + (text.length - cap);
  return text.slice(0, cap) + `\n\n… 원본에서 잘림 (전체 ${text.length.toLocaleString("ko-KR")}자)`;
}

// 도구 input 은 객체다. 통째로 자르면 JSON 이 깨지므로 문자열 값만 각각 자른다.
function cutInput(input, cap, counts) {
  if (input == null || cap == null || typeof input !== "object") return input;
  let touched = false;
  const out = Array.isArray(input) ? [...input] : { ...input };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.length > cap) {
      counts.savedChars = (counts.savedChars || 0) + (v.length - cap);
      out[k] = v.slice(0, cap) + `\n… 원본에서 잘림 (전체 ${v.length.toLocaleString("ko-KR")}자)`;
      touched = true;
    }
  }
  if (touched) counts.input = (counts.input || 0) + 1;
  return out;
}

// mode: "full"(보이는 것 동일) | "light"(남에게 보내는 용도)
export function lightenEvents(events, mode = "full") {
  const cap = CAPS[mode] || CAPS.full;
  const counts = {};
  const out = events.map((e) => {
    if (e.kind === "tool_use") {
      const result = cut(e.result, cap.result, counts, "result");
      const input = cutInput(e.input, cap.input, counts);
      return result === e.result && input === e.input ? e : { ...e, result, input };
    }
    if (e.kind === "skill_note") {
      const text = cut(e.text, cap.note, counts, "note");
      return text === e.text ? e : { ...e, text };
    }
    return e;
  });
  return { events: out, counts };
}

// 변경 탭의 diff 본문. 경량 모드에서만 파일당 줄 수를 줄인다.
const LIGHT_HUNK_LINES = 40;
export function lightenAgg(agg, mode, counts) {
  if (mode !== "light" || !agg || !Array.isArray(agg.files)) return agg;
  const files = agg.files.map((f) => {
    if (!Array.isArray(f.hunks) || f.hunks.length <= LIGHT_HUNK_LINES) return f;
    counts.hunks = (counts.hunks || 0) + 1;
    counts.savedChars = (counts.savedChars || 0) +
      f.hunks.slice(LIGHT_HUNK_LINES).reduce((n, h) => n + String(h).length, 0);
    return { ...f, hunks: f.hunks.slice(0, LIGHT_HUNK_LINES), hunksCut: f.hunks.length };
  });
  return { ...agg, files };
}
