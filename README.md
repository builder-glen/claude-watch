# 🦞 claude-watch

Claude Code 터미널 세션을 **사람이 읽기 좋은 실시간 HTML 문서**로 시각화하는 뷰어.

터미널에 흘러가는 파일 수정·명령 실행·AI 설명을 따라가기 어렵다는 문제에서 출발했습니다.
claude-watch는 Claude Code가 디스크에 기록하는 세션 로그(JSONL)를 실시간으로 읽어, 세션별로
깔끔한 카드 문서로 보여줍니다. 비개발자나 옆에서 지켜보는 사람도 "지금 AI가 뭘 하는지" 한눈에
파악할 수 있습니다.

## 동작 원리

Claude Code는 모든 세션을 `~/.claude/projects/<project>/<session>.jsonl` 에 한 줄씩 기록합니다.
claude-watch는 이 파일을 감시(tail)해서 브라우저로 실시간 전송(SSE)합니다.

```
Claude Code ──writes──> <session>.jsonl ──watch──> [로컬 서버] ──SSE──> [브라우저: 세션별 HTML]
```

- `GET /`            — 세션 목록(최근순)
- `GET /s/:id`       — 세션 전용 HTML 뷰어 (실시간 갱신)
- `GET /events/:id`  — SSE 스트림 (파일 변경 시 스냅샷 push)

## 실행

```bash
node server.mjs            # http://localhost:4317
```

환경변수 `CW_PORT` 로 포트 변경 가능.

## 렌더링 매핑

| JSONL content | 화면 |
|---|---|
| `tool_use` Bash | ⚡ 명령 + 설명 + 결과(접힘) |
| `tool_use` Edit | 📝 diff (old/new 색상) |
| `tool_use` Write | 📄 파일 생성 |
| `tool_use` Read | 📖 한 줄 |
| `assistant`/`text` | 💬 AI 설명 |
| `thinking` | 💭 생각(기본 접힘) |
| `user`/`text` | 🧑 사용자 입력 |

## 상태

MVP — 정적/실시간 뷰어 동작. 다음: 터미널 하단 OSC8 링크(statusLine) 연동, Vite+React 이관.

## 라이선스

MIT
