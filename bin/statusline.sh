#!/usr/bin/env bash
# claude-watch statusLine
#  - 기존 claude-hud 출력을 그대로 보여주고, 그 아래에 세션별 뷰어 링크(OSC8) 한 줄을 덧붙인다.
#  - 뷰어 서버가 죽어있으면 자동으로 기동한다(중복 기동 방지 락 포함).
# 주의: statusLine은 매우 자주(수백 ms) 호출되므로 가볍고 빠르게 유지한다. set -e 미사용(중간 실패로 줄이 비지 않도록).

PORT="${CW_PORT:-4317}"
SERVER="${CW_SERVER:-$HOME/Desktop/glen_projects/claude-watch/server.mjs}"
BOOT_LOCK="/tmp/claude-watch-boot.lock"

# stdin(JSON)은 한 번만 읽어 변수에 보관 (hud에 재공급해야 하므로)
input="$(cat)"

# rate_limits(구독 한도) 등 statusLine 페이로드를 뷰어가 읽도록 파일로 떨군다(파싱은 서버가)
mkdir -p "$HOME/.claude-watch" 2>/dev/null
printf '%s' "$input" > "$HOME/.claude-watch/statusline-input.json" 2>/dev/null

# 1) 서버 생존 확인(서브프로세스 없이 /dev/tcp). 죽었으면 락 잡고 1회만 detached 기동.
if ! (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  if mkdir "$BOOT_LOCK" 2>/dev/null; then
    ( nohup node "$SERVER" >/dev/null 2>&1 & )
    ( sleep 6; rmdir "$BOOT_LOCK" 2>/dev/null ) &
  fi
fi
exec 3>&- 2>/dev/null

# 2) transcript_path → 세션 id (node 스폰 없이 sed로 추출)
sid="$(printf '%s' "$input" \
  | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | sed 's#.*/##; s#\.jsonl$##')"

# 3) 기존 claude-hud 출력 그대로 (같은 stdin 재공급)
plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $0 }' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)
if [ -n "${plugin_dir:-}" ] && [ -f "${plugin_dir}dist/index.js" ]; then
  cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}')
  export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 ))
  printf '%s' "$input" | node "${plugin_dir}dist/index.js" 2>/dev/null
fi

# 4) 뷰어 링크 한 줄 추가 (OSC8 하이퍼링크 = 터미널에서 클릭 가능)
if [ -n "$sid" ]; then
  url="http://localhost:${PORT}/s/${sid}"
  printf '\n\033]8;;%s\033\\🦞 claude-watch 열기 › %s\033]8;;\033\\' "$url" "$url"
fi
