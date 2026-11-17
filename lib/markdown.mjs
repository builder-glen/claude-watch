// 내보내기 Markdown 변환 — HTML 과 같은 사본(마스킹·경량화·끈 항목 제거까지 끝난 것)을 받는다.
// 그래서 민감정보·설정 규칙이 두 형식에서 어긋나지 않는다.
//
// HTML 은 뷰어를 통째로 싣는 "보는 파일"이고, Markdown 은 위키·노션·PR 에 붙여넣는 "옮기는 파일"이다.
// 도구 호출은 <details> 로 접어 둔다(GitHub·Obsidian 모두 렌더). 대화가 도구 로그에 묻히지 않게.

// 본문에 ``` 가 들어 있어도 코드블록이 중간에 닫히지 않도록, 가장 긴 백틱 연속보다 길게 연다.
function fence(text, lang = "") {
  const s = String(text ?? "");
  const run = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(run + 1);
  return `${f}${lang}\n${s.replace(/\n+$/, "")}\n${f}`;
}

// <summary> 한 줄 — 도구가 무엇을 대상으로 했는지만 짧게
function toolLabel(e) {
  const i = e.input || {};
  const target = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || "";
  const one = String(target).split("\n")[0].slice(0, 80).replace(/[<>]/g, "");
  return `🔧 ${e.name}${one ? ` — ${one}` : ""}${e.isError ? " ⚠️ 실패" : ""}`;
}

function summaryObj(text) {
  const t = String(text || "").replace(/^\s*```\w*\n?/, "").replace(/\n?```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}

const time = (ts) => (ts ? new Date(ts).toLocaleString("ko-KR", { hour12: false }) : "");

export function toMarkdown(out, title) {
  const L = [];
  const s = out.session || {};
  const st = (out.agg && out.agg.stats) || {};
  L.push(`# ${title}`, "");
  L.push(`- 프로젝트: \`${s.project || ""}\``);
  if (st.firstTs) L.push(`- 기간: ${time(st.firstTs)} → ${time(st.lastTs)}`);
  L.push(`- 세션 ID: \`${s.id || ""}\``, "");

  const sum = out.cache && out.cache.summary && summaryObj(out.cache.summary.text);
  if (sum && sum.headline) {
    L.push("## 요약", "", `**${sum.headline}**`, "");
    if (sum.goal) L.push(`**목표** — ${sum.goal}`, "");
    const ST = { done: "완료", partial: "일부 완료", blocked: "중단" };
    if (sum.outcome) L.push(`> **${ST[sum.status] || "일부 완료"}** — ${sum.outcome}`, "");
    if ((sum.bullets || []).length) L.push("### 해결한 내용", "");
    for (const b of sum.bullets || []) L.push(`- [x] ${b}`);
    L.push("");
    if (sum.narrative) L.push(...String(sum.narrative).split(/\r?\n/).map((x) => x.trim()).filter(Boolean), "");
    const next = (Array.isArray(sum.next) ? sum.next : []).filter(Boolean);
    if (next.length) { L.push("### 남은 과제", ""); for (const n of next) L.push(`- [ ] ${n}`); L.push(""); }
  }

  const decisions = (out.agg && out.agg.decisions) || [];
  if (decisions.length) {
    L.push("## 의사결정", "");
    for (const d of decisions) L.push(`- **${d.header || d.question}** — ${d.question}${d.chosen ? `\n  - ✅ ${d.chosen}` : ""}`);
    L.push("");
  }

  const diagram = out.cache && out.cache.diagram && out.cache.diagram.text;
  if (diagram) L.push("## 구조", "", diagram.trim(), "");   // 이미 ```mermaid 블록이다

  const files = (out.agg && out.agg.files) || [];
  if (files.length) {
    L.push("## 변경 파일", "", "| 파일 | 종류 | +/- |", "|---|---|---|");
    for (const f of files) L.push(`| \`${f.path}\` | ${f.kind} | +${f.add || 0} / -${f.del || 0} |`);
    L.push("");
  }

  const events = out.events || [];
  if (events.length) {
    L.push("## 대화", "");
    let speaker = "";   // 연속 응답은 헤더 하나로 묶는다(뷰어의 턴 단위와 같은 감각)
    const head = (who, ts) => {
      if (speaker === who) return;
      speaker = who;
      L.push(`### ${who === "user" ? "👤 사용자" : "🤖 Claude"}${ts ? ` · ${time(ts)}` : ""}`, "");
    };
    for (const e of events) {
      if (e.kind === "user_text") {
        head("user", e.ts);
        L.push(e.text || "", "");
      } else if (e.kind === "assistant_text") {
        head("claude", e.ts);
        L.push(e.text || "", "");
      } else if (e.kind === "thinking") {
        head("claude", e.ts);
        L.push("<details><summary>💭 생각</summary>", "", e.text || "", "", "</details>", "");
      } else if (e.kind === "tool_use") {
        head("claude", e.ts);
        L.push(`<details><summary>${toolLabel(e)}</summary>`, "");
        if (e.input && Object.keys(e.input).length) L.push(fence(JSON.stringify(e.input, null, 2), "json"), "");
        if (e.result) L.push(fence(e.result), "");
        L.push("</details>", "");
      } else if (e.kind === "system_note" || e.kind === "skill_note") {
        L.push(`<details><summary>⚙️ ${e.kind === "skill_note" ? `스킬 주입${e.skill ? ` · ${e.skill}` : ""}` : "시스템 주입"}</summary>`, "",
          fence(e.text), "", "</details>", "");
      }
    }
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n");
}
