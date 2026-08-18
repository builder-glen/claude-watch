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
| `GET /vendor/:file` | 뷰어가 쓰는 로컬 자산(마크다운·코드색·다이어그램·폰트) |
| `POST /api/diagram-svg/:id` | 뷰어가 그린 다이어그램 SVG를 캐시에 저장(내보내기용) |

### 외부 CDN을 쓰지 않는 이유

뷰어가 쓰는 라이브러리와 폰트는 전부 `public/vendor/` 에 두고 로컬에서 불러옵니다.
내보낸 HTML은 **남에게 보내는 파일**이라, CDN 링크가 남아 있으면 두 가지가 문제입니다.

- 받는 사람 인터넷이 막혀 있으면 마크다운·코드색·다이어그램이 깨진다
- 파일을 여는 것만으로 외부 도메인에 접속 기록이 남는다

내보낼 때 서버가 이 자산들을 파일 내용 자체로 바꿔 넣습니다(`inlineVendor`).
`mermaid`(3.2MB)만 예외로, 싣는 대신 뷰어가 미리 그려둔 SVG를 넣습니다 —
결과가 같으니 받는 쪽에서 다시 그릴 이유가 없고 용량도 3.2MB → 수십 KB로 줄어듭니다.
그래서 **[구조] 탭을 한 번 열어본 뒤 내보내야** 다이어그램이 함께 나갑니다.

본문 한글 폰트(Pretendard)는 싣지 않습니다. 한글 글리프 전체는 4종 합쳐 2.6MB라
"메신저로 보낼 수 있는 파일"과 맞지 않습니다. 설치돼 있으면 그대로 쓰고,
없으면 OS 기본 한글 폰트로 떨어집니다.

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

## 보안 · 프라이버시

이 뷰어는 **세션 전문**을 그대로 보여줍니다 — 대화, 읽은 파일 내용, 실행한 명령과 그 출력이
전부 포함되고, 거기에 API 키나 토큰이 섞여 있을 수 있습니다.

- **기본은 `127.0.0.1` 전용**입니다. 같은 네트워크의 다른 기기에서 접근할 수 없습니다.
  인증 기능이 없으므로 `CW_HOST=0.0.0.0` 은 신뢰하는 망에서만 쓰세요.
- 상태를 바꾸는 요청(내보내기·이름변경·AI 생성·폴더 선택)은 **같은 출처에서만** 받습니다.
  방문한 웹페이지가 `localhost:4317` 을 몰래 호출하는 것을 막습니다.
- **원본 세션 로그는 읽기만 합니다.** 수정·삭제하지 않습니다.
- 내보낸 HTML을 **남에게 줄 때는 "민감 정보 마스킹"을 체크**하세요. 체크하면 API 키·토큰·JWT·
  개인키·URL 자격증명을 가린 사본이 저장되고, 몇 개를 가렸는지 알려줍니다.
  체크하지 않으면 원본 그대로 나갑니다.
- AI 요약·다이어그램은 로컬의 `claude` CLI를 호출합니다. 세션 다이제스트가 Anthropic으로
  전송되며, 결과는 `~/.claude-watch/cache/` 에 남습니다. 원하지 않으면 그 기능을 쓰지 마세요.

## 제거

```bash
rm -rf ~/.claude-watch          # 캐시·색인·내보낸 파일
rm /usr/local/bin/cw            # 심볼릭 링크를 만들었다면
```

`~/.claude/settings.json` 의 `statusLine` 항목도 지우세요.

### 개발 시 주의점

- **statusLine 이 서버를 자동으로 되살린다.** 포트 4317 이 비면 `bin/statusline.sh` 가 서버를 띄우는데,
  그 서버는 `CW_DEV` 없이 떠서 HTML 을 메모리에 캐시한다 → 뷰어를 고쳐도 화면이 안 바뀐다.
  `lsof -ti:4317 | xargs kill` 후 `CW_DEV=1 node server.mjs` 로 다시 띄울 것
- **의존성 0 을 유지한다.** `package.json` 도 없다. 받아서 바로 실행되는 게 이 도구의 장점이다
- **원본 세션 로그는 읽기 전용.** 수정·삭제하지 않는다
- 글자 크기는 뷰어의 보기 설정에서 조절한다. 코드의 px 를 직접 만지지 말 것
  (`DEFAULT_ROLES` 상수가 기본 배율)

## 기여 · 작업 규칙

- 브랜치: `<이름>-yymmdd-N` (예: `glen-260818-1`). `main` 직접 커밋은 하지 않는다
- 커밋: Conventional Commits + 한국어 본문 (`fix(viewer): …`, `feat(export): …`)
- 머지: 작업 브랜치 → PR → 머지
- 주석은 한국어

## 라이선스

[MIT](LICENSE) — 자유롭게 쓰고 고치고 배포하세요. 저작권 표시만 남겨주시면 됩니다.
