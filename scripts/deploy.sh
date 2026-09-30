#!/usr/bin/env bash
#
# One-command deploy to this machine: verify → build → restart → health-check.
#
# There is no rollback, and pretending otherwise would be worse than saying so:
# the backend runs the TypeScript sources directly through tsx, so a "previous
# build" does not exist, and this script deliberately does not touch git. What
# it gives you instead is that every check runs BEFORE the running service is
# stopped — a broken tree fails the deploy without taking the service down.
#
# Two modes, detected automatically:
#
#   systemd  — the `ajt` user unit is installed (the normal case). The unit owns
#              the bind address and the restart policy; this script only
#              verifies, builds and calls `systemctl --user restart ajt`.
#              --host/--port are ignored: edit ~/.config/systemd/user/ajt.service.
#   nohup    — no unit installed. This script starts the process itself and you
#              must say where to bind.
#
# Usage:
#   scripts/deploy.sh                         # systemd mode: just deploy
#   scripts/deploy.sh --host 127.0.0.1        # nohup mode: local only (SSH tunnel)
#   scripts/deploy.sh --skip-checks           # emergency: skip typecheck+tests
#   scripts/deploy.sh --install               # force npm ci even if deps look fresh
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$ROOT/ajt-web.log"

PORT="${AJT_PORT:-9300}"
HOST=""
SKIP_CHECKS=0
FORCE_INSTALL=0
ALLOW_PUBLIC=0
HEALTH_TIMEOUT=45

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --install) FORCE_INSTALL=1; shift ;;
    --allow-public) ALLOW_PUBLIC=1; shift ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && die "别用 root 跑（进程属主会变，日志和 .env 的权限会乱）"
[ -f "$ROOT/.env" ] || die "缺少 .env —— 里面有 ATLASSIAN/ANTHROPIC 的凭据和 SESSION_SECRET"

# ── 模式判定 ────────────────────────────────────────────────────────────────
#
# 装了 systemd unit 就必须走 systemctl：unit 里是 Restart=always，脚本自己
# kill 掉进程的话 systemd 会立刻用 unit 的环境变量把它拉回来,--host 全白给,
# 还会和这里的健康检查抢时序。
MODE=nohup
if systemctl --user is-enabled ajt >/dev/null 2>&1 || systemctl --user is-active ajt >/dev/null 2>&1; then
  MODE=systemd
  UNIT_ENV="$(systemctl --user show ajt -p Environment --value 2>/dev/null || true)"
  case "$UNIT_ENV" in *AJT_PORT=*) PORT="${UNIT_ENV##*AJT_PORT=}"; PORT="${PORT%% *}" ;; esac
  [ -n "$HOST" ] && warn "systemd 模式下 --host 无效,绑定地址由 ~/.config/systemd/user/ajt.service 决定"
  HOST=""
  case "$UNIT_ENV" in *AJT_HOST=*) HOST="${UNIT_ENV##*AJT_HOST=}"; HOST="${HOST%% *}" ;; esac
fi

# ── 绑定地址（仅 nohup 模式）────────────────────────────────────────────────
#
# .env 里写的是 AJT_HOST=0.0.0.0，而这台机器的安全组对 0.0.0.0/0 全端口放行，
# 照着 .env 部署等于把登录页明文挂上公网。所以这里必须显式决定绑哪里，并且
# export 出去压过 .env（dotenv 不覆盖已存在的环境变量）。
if [ "$MODE" = "nohup" ] && [ -z "$HOST" ]; then
  if TS_IP="$(tailscale ip -4 2>/dev/null | head -1)" && [ -n "$TS_IP" ]; then
    HOST="$TS_IP"
    note "绑定 Tailscale 地址 $HOST"
  else
    die "没指定 --host，且 Tailscale 不可用（$(tailscale status 2>&1 | head -1)）。
     明确选一个：
       --host 127.0.0.1   仅本机，外部走 SSH 隧道   ssh -L $PORT:localhost:$PORT <本机>
       --host <tailscale> 先 tailscale up 重新登录
       --host 0.0.0.0 --allow-public   对公网开放（安全组是全开的，登录页会裸奔在 HTTP 上）"
  fi
fi

# 这道闸只管 nohup 模式:那里是脚本自己在选绑哪里。systemd 模式下绑定地址是
# unit 文件里已经做过的决定,每次部署都拦一次只是噪音 —— 改那个决定要去改 unit。
if [ "$MODE" = "systemd" ] && [ "$HOST" = "0.0.0.0" ]; then
  warn "服务绑在 0.0.0.0(unit 文件决定)—— 公网可达,明文 HTTP"
elif [ "$HOST" = "0.0.0.0" ] && [ "$ALLOW_PUBLIC" -ne 1 ]; then
  die "拒绝绑 0.0.0.0：安全组 sg-0958c34dd730887c8 对 0.0.0.0/0 全端口放行，
     这会把登录页挂到公网明文 HTTP 上。确实要这么做就加 --allow-public。"
fi
[ "$HOST" = "0.0.0.0" ] && warn "绑定 0.0.0.0 —— 公网可达，且是明文 HTTP"

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
step "依赖"
if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  note "npm ci"
  npm ci
else
  note "node_modules 比 package-lock.json 新，跳过（--install 可强制）"
fi

# ── 2. 验证：全部在停服务之前跑完 ──────────────────────────────────────────
if [ "$SKIP_CHECKS" -eq 1 ]; then
  warn "跳过 typecheck 与测试（--skip-checks）"
else
  step "类型检查"
  npm run typecheck
  step "测试"
  npm test
fi

# ── 3. 构建前端 ─────────────────────────────────────────────────────────────
# Express 从磁盘读 web/dist，所以这一步单独跑也能生效；放在重启前是为了
# 让新前端和新后端同时上线，而不是先出现一段版本错配的窗口。
step "构建前端"
npm run build:web

# ── 4/5. 重启 ───────────────────────────────────────────────────────────────
if [ "$MODE" = "systemd" ]; then
  step "重启服务（systemd）"
  systemctl --user restart ajt
  note "systemctl --user status ajt · journalctl --user -u ajt -f"
else

# 按端口杀而不是按进程名匹配：名字匹配会误伤别的端口上的实例（比如临时起来
# 验证用的那个），而端口是唯一真正冲突的资源。
step "停止旧实例"
OLD_PIDS="$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
if [ -n "$OLD_PIDS" ]; then
  for pid in $OLD_PIDS; do
    note "kill $pid ($(ps -p "$pid" -o etime= --no-headers 2>/dev/null | tr -d ' ' || echo '?') 运行时长)"
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 20); do
    ss -tln 2>/dev/null | grep -q ":$PORT " || break
    sleep 0.5
  done
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then
    for pid in $OLD_PIDS; do kill -9 "$pid" 2>/dev/null || true; done
    sleep 1
  fi
  ss -tln 2>/dev/null | grep -q ":$PORT " && die "端口 $PORT 仍被占用，没敢继续"
else
  note "端口 $PORT 上没有在跑的实例"
fi

# 别的端口上还有 ajt 实例就提一句，但不动它 —— 可能是别人在用
STRAY="$(pgrep -f "tsx src/serve[r]" 2>/dev/null | tr '\n' ' ' || true)"
[ -n "$STRAY" ] && warn "另有 ajt 进程在跑（pid $STRAY），不在端口 $PORT 上，未动它"

# ── 5. 启动 ─────────────────────────────────────────────────────────────────
step "启动"
export AJT_HOST="$HOST" AJT_PORT="$PORT"   # 压过 .env：dotenv 不覆盖已有环境变量
: > "$LOG"
setsid nohup npm run web >> "$LOG" 2>&1 &
note "日志 → $LOG"

fi

# ── 6. 健康检查 ─────────────────────────────────────────────────────────────
step "健康检查"
PROBE="http://${HOST:-127.0.0.1}:$PORT"   # 探测:0.0.0.0 不是可连接地址
URL="$PROBE"                              # 展示:给人看的那个
if [ "$HOST" = "0.0.0.0" ]; then
  PROBE="http://127.0.0.1:$PORT"
  PUB="$(curl -s --max-time 2 -H "X-aws-ec2-metadata-token: $(curl -s -X PUT --max-time 2 \
        'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null)" \
        http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
  URL="http://${PUB:-<本机公网IP>}:$PORT"
fi
for i in $(seq "$HEALTH_TIMEOUT"); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$PROBE/healthz" 2>/dev/null)" = "200" ]; then
    NEW_PID="$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || echo '?')"
    printf '\n\033[32m✓ 部署完成\033[0m  %s  (pid %s, %ss)\n' "$URL" "$NEW_PID" "$i"
    if [ "$MODE" = "systemd" ]; then
      journalctl --user -u ajt -n 20 --no-pager 2>/dev/null | grep -E "已启动" | tail -1 || true
    else
      grep -E "已启动" "$LOG" | tail -1 || true
    fi
    [ "$HOST" = "127.0.0.1" ] && note "外部访问：ssh -L $PORT:localhost:$PORT <这台服务器>"
    exit 0
  fi
  sleep 1
done

printf '\n'
warn "${HEALTH_TIMEOUT}s 内 /healthz 没有返回 200。日志末尾："
if [ "$MODE" = "systemd" ]; then
  journalctl --user -u ajt -n 30 --no-pager >&2 || true
  die "部署失败。代码没有回滚（本脚本不碰 git）；systemd 仍在按 Restart=always 反复拉起,
     用 systemctl --user stop ajt 让它安静下来,修好后重跑本脚本。"
else
  tail -30 "$LOG" >&2
  die "部署失败。代码没有回滚（本脚本不碰 git）；旧实例已经停了，修好后重跑本脚本。"
fi
