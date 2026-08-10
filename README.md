# 🦞 Claude-watch

## Claude Code 세션 로그(JSONL)를 사람이 읽기 좋은 실시간 HTML 문서로 보여주는 로컬 뷰어.
### 세션을 실수로 닫거나, 지난 로컬 세션 기록을 찾아보는게 영 귀찮고 짜증나서 만든 기능, 지속 업데이트 중
- 요약 / 구조 / 변경 / 대화 4개 탭으로 세션을 관리할 수 있음
- 실시간 갱신(SSE) 새 활동만 증분 전송, 펼쳐둔 항목 유지
- 서브에이전트·모델 전환·토큰/비용 표시
- 자체완결 HTML로 내보내기(민감정보 마스킹 선택)

## 요구 사항

- Node.js 18+ (의존성 0 — Node 내장 모듈만 사용)
- Claude Code (세션 로그를 `~/.claude/projects/` 에 남기는 주체)
- macOS 권장 — `bin/cw`, `bin/statusline.sh`, 내보내기 폴더 선택창이 macOS 기준

## 설치

```bash
git clone https://github.com/builder-glen/claude-watch.git
cd claude-watch
node server.mjs            # http://localhost:4317
```

빌드 단계 없음. `npm install` 필요 없음.

### 터미널 하단 링크 + 자동 기동 (선택)

`~/.claude/settings.json` 에 statusLine을 등록하면, Claude Code를 쓸 때마다 터미널 하단에
현재 세션 뷰어 링크가 뜨고 서버가 자동으로 뜹니다.

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /절대경로/claude-watch/bin/statusline.sh"
  }
}
```

기존에 claude-hud를 쓰고 있으면 그 출력을 그대로 유지한 채 링크 한 줄만 덧붙입니다.

### cw 명령 등록 (선택)

```bash
ln -s "$PWD/bin/cw" /usr/local/bin/cw
```

## 명령

| 명령 | 하는 일 |
|---|---|
| `node server.mjs` | 서버 실행 (기본 포트 4317) |
| `CW_PORT=5000 node server.mjs` | 포트 변경 |
| `CW_DEV=1 node server.mjs` | 개발 모드 — HTML을 매 요청마다 다시 읽음(새로고침만으로 반영) |
| `cw history` | 최근 세션 목록을 터미널에 출력 |
| `cw open <n>` | n번 세션을 브라우저로 열기 |
| `cw web` | 전체 세션 목록 페이지 열기 |
| `cw rename <n> "제목"` | 세션 제목 바꾸기 |
| `cw project <n> "이름"` | 세션의 프로젝트 재지정 |

## HTTP 엔드포인트

| 경로 | 내용 |
|---|---|
| `GET /` | 세션 목록 페이지 |
| `GET /s/:id` | 세션 뷰어 |
| `GET /api/index` | 세션 색인(JSON) |
| `GET /api/session/:id` | 이벤트 + 집계(JSON) |
| `GET /events/:id` | SSE — `init` 1회 후 `patch`(변경분만) |
| `GET /export/:id` | 자체완결 HTML 저장. `?dir=&name=&mask=1` |
| `GET /api/ai/summary\|diagram/:id` | AI 요약·다이어그램 생성(`claude -p`, 별도 키 불필요) |

## 설치되는 것 / 만들어지는 것

레포 밖에 만드는 건 전부 `~/.claude-watch/` 아래이며, **원본 세션 로그는 절대 수정하지 않습니다.**

| 경로 | 내용 |
|---|---|
| `~/.claude-watch/index.json` | 세션 색인 캐시(mtime 비교로 바뀐 것만 갱신) |
| `~/.claude-watch/cache/` | AI 요약·다이어그램 결과 캐시 |
| `~/.claude-watch/exports/` | 내보낸 HTML 기본 저장 위치 |
| `~/.claude-watch/aliases.json` | 사용자가 바꾼 세션 제목 |
| `~/.claude-watch/project-overrides.json` | 사용자가 재지정한 프로젝트 |
| `~/.claude-watch/statusline-input.json` | statusLine이 넘겨준 구독 한도 등 |

읽기만 하는 것: `~/.claude/projects/**/*.jsonl` (세션 로그), `<세션id>/subagents/*.jsonl` (서브에이전트 전사).

## 제거

```bash
rm -rf ~/.claude-watch          # 캐시·색인·내보낸 파일
rm /usr/local/bin/cw            # 심볼릭 링크를 만들었다면
```

`~/.claude/settings.json` 의 `statusLine` 항목도 지우세요.

## 라이선스

MIT
