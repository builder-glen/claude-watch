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

// ── 내보내기 설정에 따른 제거 ────────────────────────────────────────
// "숨김"을 CSS 로 가리지 않고 데이터에서 실제로 뺀다.
// 화면에서만 가리면 받는 사람이 소스 보기로 전부 볼 수 있어서, 숨겼다는 기대와 어긋난다.
// 빼면 용량도 함께 준다.
// 화면에 있는 요소를 그대로 나열한다. 사용자가 보는 것과 설정 항목이 1:1 이어야
// "이걸 끄면 뭐가 사라지지?"를 따로 상상하지 않아도 된다.
export const ELEMENTS = [
  ["상단바", [
    ["hero.turns",  "주고받은 대화 수"],
    ["hero.agents", "서브에이전트 수"],
    ["hero.cost",   "쓴 토큰 · 비용"],
    ["hero.diff",   "바뀐 코드 줄"],
  ]],
  ["탭", [
    ["tab.summary", "요약"],
    ["tab.arch",    "구조"],
    ["tab.changes", "변경"],
    ["tab.raw",     "대화"],
  ]],
  ["요약 탭", [
    ["sum.ai",        "AI 요약"],
    ["sum.skills",    "사용한 스킬"],
    ["sum.tools",     "도구 호출 통계"],
    ["sum.agents",    "서브에이전트"],
    ["sum.models",    "모델"],
    ["sum.decisions", "의사결정"],
    ["sum.files",     "산출물 · 변경 핫스팟"],
  ]],
  ["대화 탭", [
    ["chat.tools", "도구 실행 로그"],
    ["chat.think", "생각 과정"],
    ["chat.sys",   "시스템 메시지"],
    ["chat.model", "모델 표시"],
    ["chat.tok",   "토큰 표시"],
  ]],
  ["파일", [
    ["file.mask",  "민감 정보 마스킹"],
    ["file.light", "경량으로 내보내기"],
  ]],
];

export const ALL_KEYS = ELEMENTS.flatMap(([, l]) => l.map(([k]) => k));

// 기본값 — 전부 켜되 마스킹·경량은 켠다(남에게 보내는 게 주 용도라서).
export const DEFAULT_EXPORT_CONFIG = {
  show: Object.fromEntries(ALL_KEYS.map((k) => [k, true])),
};

// 데이터에서 실제로 뺄지는 "그 데이터를 쓰는 요소가 전부 꺼졌는가"로 정한다.
// 하나라도 켜져 있으면 남겨야 화면이 깨지지 않는다.
export function applyVisibility(payload, show = {}, counts = {}) {
  const on = (k) => show[k] !== false;
  const dropUsage  = !on("hero.cost") && !on("chat.tok") && !on("sum.models");
  const dropModel  = !on("chat.model") && !on("sum.models");
  const dropAgents = !on("hero.agents") && !on("sum.agents");
  const dropFiles  = !on("tab.changes") && !on("sum.files") && !on("hero.diff");

  let events = [];
  if (!on("tab.raw")) {
    // 대화 탭을 끄면 본문 전체가 필요 없다. 요약·구조·변경 탭은 agg 로 그린다.
    counts.chatDropped = payload.events.length;
  } else {
    for (const e of payload.events) {
      if (!on("chat.sys") && (e.kind === "system_note" || e.kind === "skill_note")) { counts.sysDropped = (counts.sysDropped || 0) + 1; continue; }
      if (!on("chat.think") && e.kind === "thinking") { counts.thinkDropped = (counts.thinkDropped || 0) + 1; continue; }
      let x = e;
      if (e.kind === "tool_use" && !on("chat.tools")) {
        // 도구를 통째로 지우면 "무엇을 했는지"가 사라진다. 이름·성공여부는 남기고 본문만 뺀다
        // (요약 탭의 도구 호출 통계도 이름으로 센다).
        const { result, input, ...rest } = e;
        x = { ...rest, result: result == null ? null : "", stripped: true };
        counts.toolsStripped = (counts.toolsStripped || 0) + 1;
      }
      if (dropUsage && x.usage) { const { usage, ...r } = x; x = r; counts.costDropped = (counts.costDropped || 0) + 1; }
      if (dropModel && x.model) { const { model, ...r } = x; x = r; }
      events.push(x);
    }
  }

  const agg = { ...payload.agg };
  if (dropAgents) agg.agents = [];
  if (dropFiles) agg.files = [];
  if (!on("sum.skills")) agg.skills = [];
  if (!on("sum.tools")) agg.tools = { total: 0, list: [] };
  if (!on("sum.decisions")) agg.decisions = [];
  if (dropModel) agg.models = { ...(agg.models || {}), list: [] };

  const cache = { ...(payload.cache || {}) };
  if (!on("sum.ai")) cache.summary = null;
  if (!on("tab.arch")) cache.diagram = null;

  return { ...payload, events, agg, cache };
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
