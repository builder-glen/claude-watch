// 공유용 마스킹 — 내보낸 HTML을 남에게 줄 때 자격증명이 같이 나가는 걸 막는다.
// 원칙:
//  1) 원본 로그는 절대 건드리지 않는다. 내보낼 사본에만 적용한다.
//  2) 못 지우는 것보다 과하게 지우는 쪽이 낫다(오탐 허용).
//  3) 무엇이 몇 개 가려졌는지 세어서 사용자에게 알린다.

// [이름, 정규식, 치환값] — 앞쪽 규칙이 먼저 먹는다(구체적인 것부터).
const RULES = [
  ["Anthropic 키",  /sk-ant-[A-Za-z0-9_\-]{20,}/g,                    "sk-ant-••••"],
  ["OpenAI 키",     /sk-(?:proj-)?[A-Za-z0-9_\-]{32,}/g,              "sk-••••"],
  ["GitHub 토큰",   /gh[pousr]_[A-Za-z0-9]{20,}/g,                    "ghp_••••"],
  ["GitHub PAT",    /github_pat_[A-Za-z0-9_]{30,}/g,                  "github_pat_••••"],
  ["Slack 토큰",    /xox[baprs]-[A-Za-z0-9\-]{10,}/g,                 "xoxb-••••"],
  ["Google 키",     /AIza[A-Za-z0-9_\-]{30,}/g,                       "AIza••••"],
  ["AWS 액세스키",  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                 "AKIA••••"],
  ["JWT",           /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "eyJ••••"],
  ["Bearer 토큰",   /\b[Bb]earer\s+[A-Za-z0-9._\-]{16,}/g,            "Bearer ••••"],
  ["Basic 인증",    /\b[Bb]asic\s+[A-Za-z0-9+/=]{16,}/g,              "Basic ••••"],
  // 치환에 캡처($1)를 쓰려면 함수여야 한다 — 문자열 치환은 아래 카운팅 래퍼를 거치며 $n 이 리터럴로 남는다.
  ["URL 내 자격증명", /\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, (m, proto) => `${proto}••••:••••@`],
  ["PEM 개인키",    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----\n••••\n-----END PRIVATE KEY-----"],
  // KEY=값 / "token": "값" 형태의 일반 시크릿. 값이 8자 이상일 때만.
  ["환경변수 시크릿", /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"',;]{8,})\3/gi,
                     (m, k, sep, q, _v) => `${k}${sep}${q}••••${q}`],
];

// 문자열 하나를 마스킹. counts에 규칙별 적중 수를 누적한다.
export function maskText(text, counts) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [name, re, rep] of RULES) {
    let n = 0;
    out = out.replace(re, (...args) => { n++; return typeof rep === "function" ? rep(...args) : rep; });
    if (n) counts[name] = (counts[name] || 0) + n;
  }
  return out;
}

// 객체 안의 모든 문자열을 재귀적으로 마스킹(도구 input/result가 중첩 객체라서 필요).
function maskDeep(v, counts, depth = 0) {
  if (depth > 8) return v;
  if (typeof v === "string") return maskText(v, counts);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, counts, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = maskDeep(val, counts, depth + 1);
    return out;
  }
  return v;
}

// 이벤트 배열 전체를 마스킹한 '사본'을 돌려준다. 원본 배열은 그대로 둔다.
export function maskEvents(events) {
  const counts = {};
  const masked = events.map((e) => {
    const copy = { ...e };
    if (typeof copy.text === "string") copy.text = maskText(copy.text, counts);
    if (typeof copy.result === "string") copy.result = maskText(copy.result, counts);
    if (copy.input) copy.input = maskDeep(copy.input, counts, 0);
    return copy;
  });
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { events: masked, counts, total };
}

// 집계(파일 diff 본문 등)에도 같은 규칙을 적용
export function maskAgg(agg, counts) {
  const out = { ...agg };
  if (Array.isArray(agg.files)) {
    out.files = agg.files.map((f) => ({
      ...f,
      hunks: (f.hunks || []).map((h) => ({ ...h, text: maskText(h.text, counts) })),
    }));
  }
  return out;
}
