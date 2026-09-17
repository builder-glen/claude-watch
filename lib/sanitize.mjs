// 공유용 마스킹 — 내보낸 HTML을 남에게 줄 때 자격증명이 같이 나가는 걸 막는다.
// 원칙:
//  1) 원본 로그는 절대 건드리지 않는다. 내보낼 사본에만 적용한다.
//  2) 못 지우는 것보다 과하게 지우는 쪽이 낫다(오탐 허용).
//  3) 무엇이 몇 개 가려졌는지 세어서 사용자에게 알린다.
//  4) 정규식은 완벽할 수 없다. 화면에도 "자동 탐지는 완벽하지 않다"고 알린다.
//
// 2026-09-17 감사: 흔한 비밀값 30종 중 22종이 통과했다 — JSON 의 "password": "…" (키 뒤의
// 따옴표 때문에 일반 규칙이 안 맞음), Stripe·npm·GitLab 등 서비스 토큰, 웹훅 URL, 개인정보, 홈 경로.

// [이름, 정규식, 치환값] — 앞쪽 규칙이 먼저 먹는다(구체적인 것부터).
const RULES = [
  ["Anthropic 키",  /sk-ant-[A-Za-z0-9_\-]{20,}/g,                    "sk-ant-••••"],
  ["OpenAI 키",     /sk-(?:proj-)?[A-Za-z0-9_\-]{32,}/g,              "sk-••••"],
  ["GitHub 토큰",   /gh[pousr]_[A-Za-z0-9]{20,}/g,                    "ghp_••••"],
  ["GitHub PAT",    /github_pat_[A-Za-z0-9_]{30,}/g,                  "github_pat_••••"],
  ["Slack 토큰",    /xox[baprs]-[A-Za-z0-9\-]{10,}/g,                 "xoxb-••••"],
  ["Stripe 키",     /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,        "sk_live_••••"],
  ["npm 토큰",      /\bnpm_[A-Za-z0-9]{30,}/g,                        "npm_••••"],
  ["GitLab 토큰",   /\bglpat-[A-Za-z0-9_\-]{20,}/g,                   "glpat-••••"],
  ["SendGrid 키",   /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, "SG.••••"],
  ["Google OAuth",  /\bya29\.[A-Za-z0-9_\-]{20,}/g,                   "ya29.••••"],
  ["HuggingFace 토큰", /\bhf_[A-Za-z0-9]{30,}/g,                      "hf_••••"],
  ["Figma 토큰",    /\bfigd_[A-Za-z0-9_\-]{20,}/g,                    "figd_••••"],
  ["Notion 토큰",   /\b(?:secret|ntn)_[A-Za-z0-9]{40,}/g,             "secret_••••"],
  ["Slack 웹훅",    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g, "https://hooks.slack.com/services/••••"],
  ["Discord 웹훅",  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_\-]+/g, "https://discord.com/api/webhooks/••••"],
  ["Telegram 봇 토큰", /\b\d{8,10}:[A-Za-z0-9_\-]{35}\b/g,            "••••:••••"],
  ["Google 키",     /AIza[A-Za-z0-9_\-]{30,}/g,                       "AIza••••"],
  ["AWS 액세스키",  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                 "AKIA••••"],
  ["JWT",           /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "eyJ••••"],
  ["Bearer 토큰",   /\b[Bb]earer\s+[A-Za-z0-9._\-]{16,}/g,            "Bearer ••••"],
  ["Basic 인증",    /\b[Bb]asic\s+[A-Za-z0-9+/=]{16,}/g,              "Basic ••••"],
  ["Authorization 헤더", /\b(Authorization:\s*(?:token|apikey)\s+)[A-Za-z0-9._\-]{16,}/gi, (m, p) => `${p}••••`],
  ["curl 계정",     /((?:\s-u|--user)[=\s]+)(["']?)[^\s:"']+:[^\s"']+\2/g, (m, p, q) => `${p}${q}••••:••••${q}`],
  ["mysql 비밀번호", /(\bmysql\b[^\n]*?\s-p)([^\s]{4,})/g,            (m, p) => `${p}••••`],
  // 치환에 캡처($1)를 쓰려면 함수여야 한다 — 문자열 치환은 아래 카운팅 래퍼를 거치며 $n 이 리터럴로 남는다.
  ["URL 내 자격증명", /\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^\s/@:]+:[^\s/]+@/g, (m, proto) => `${proto}••••:••••@`],
  ["PEM 개인키",    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----\n••••\n-----END PRIVATE KEY-----"],
  // KEY=값 / "token": "값" 형태의 일반 시크릿. 값이 8자 이상일 때만.
  // 키가 따옴표로 감싸인 JSON 형태("password": "…")도 잡도록 키 앞뒤의 따옴표를 허용한다.
  ["환경변수 시크릿", /(["']?)\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\1(\s*[=:]\s*)(["']?)([^\s"',;]{8,})\4/gi,
                     (m, kq, k, sep, q, _v) => `${kq}${k}${kq}${sep}${q}••••${q}`],
  // ── 개인정보 · 환경 정보 ──
  ["이메일",        /\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+)\b/g, (m, domain) => `••••@${domain}`],
  ["주민등록번호",  /\b\d{6}[-\s]?[1-4]\d{6}\b/g,                     "••••••-•••••••"],
  ["전화번호",      /\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,      "010-••••-••••"],
  ["카드번호",      /\b(?:\d{4}[-\s]){3}\d{4}\b/g,                    "••••-••••-••••-••••"],
  // 홈 경로의 계정 이름. 받는 사람에게 필요 없는 정보고, 실명인 경우가 많다.
  ["홈 경로 계정명", /(\/(?:Users|home)\/)(?!••••)[^\/\s"'`:<>|]+/g,  (m, p) => `${p}••••`],
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
  if (depth > 16) return v;
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

// 내보낼 payload 전체를 마스킹한다. 예전엔 events·files·AI 캐시만 골라 가렸는데, 의사결정·에이전트 설명·
// 세션 경로처럼 빠진 곳으로 값이 새어 나갔다. 빠뜨릴 수 없도록 통째로 돈다.
export function maskPayload(payload) {
  const counts = {};
  const value = maskDeep(payload, counts, 0);
  return { value, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) };
}
