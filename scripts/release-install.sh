#!/bin/sh
# 装 release 的本机流程，步骤顺序与 src/company-upgrade-runner.ts 的 runCompanyUpgrade 一致：
#   1 校验版本  2 生成固定快照  3 安装依赖并类型检查  4 本机发布门禁
#   5 确认派工已暂停  6 公司库迁移（仅云端）  7 切换现役版本  8 验证
# 失败安全：切换前失败保持现役版本不变；切换后失败用 company-service.sh 恢复上一版本。
# 不读取、不输出任何令牌或 secret。
#
# 未在脚本中实现（需由其他途径完成，见交付报告）：派工暂停的数据库事务与暂停状态恢复、升级任务记录与审计、
# owner 任务版本校验、schema 读回核验（verifyReleaseSchema）、并发互斥与超时进程组。
#
# usage: sh scripts/release-install.sh <40 位小写十六进制 main 提交 sha>
# 环境变量：
#   SCK_SERVICE_HOME                服务目录（缺省 $HOME/Library/Application Support/SurrealCKCompany）
#   SCK_OPS_REPO                    运营仓检出目录（缺省读 private/service.env 的 SCK_AGENT_CWD）
#   SCK_RELEASE_INSTALL_DRY_RUN=1   只打印将执行的步骤，不改动任何东西
#   SCK_RELEASE_DISPATCH_PAUSED=1   老板侧已暂停派工；未设置则在切换前拒绝
#   COMPANY_DB_URL                  已配置即云端模式，切换前调用公司库迁移
set -u

here=$(cd "$(dirname "$0")" && pwd)
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
sha=${1:-}
PYTHON=/usr/bin/python3
SWITCHED=0
SKIP_SWITCH=0
PREVIOUS=""

# 1. sha 校验：先于任何目录操作，非法输入不改动任何东西。
case "$sha" in
  ''|*[!0-9a-f]*)
    echo "拒绝：提交 sha 必须是 40 位小写十六进制，收到的参数不合法，未做任何改动" >&2
    echo '结果: 失败 原因=提交 sha 不合法'
    exit 1;;
esac
if [ "${#sha}" -ne 40 ]; then
  echo "拒绝：提交 sha 必须是 40 位（当前 ${#sha} 位），未做任何改动" >&2
  echo '结果: 失败 原因=提交 sha 长度不合法'
  exit 1
fi
target="$service_home/releases/$sha"

. "$here/release-content.sh"

is_sha() { case "$1" in ''|*[!0-9a-f]*) return 1;; esac; [ "${#1}" -eq 40 ]; }
# 版本比较：输出 1、0 或 -1（与 compareRelease 同序）。
vcmp() {
  "$PYTHON" -c 'import sys
def p(v): return tuple(int(x) for x in v.split("."))
a, b = p(sys.argv[1]), p(sys.argv[2])
print((a > b) - (a < b))' "$1" "$2"
}
real_path() { "$PYTHON" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
read_version() { "$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("version", ""))' "$1" 2>/dev/null; }
# 与 release-gate.sh 的门禁名对应；0.3.76 起才有 recovery-fork（与 gatesFor 一致）。
gates_for() {
  echo comm-slow-pipe
  echo sidecar-review
  if [ "$(vcmp "$1" 0.3.76)" -ge 0 ]; then echo recovery-fork; fi
  return 0
}
health() {
  hl_port=$1; hl_path=$2; hl_i=0
  case "$hl_port" in ''|*[!0-9]*) return 1;; esac
  while [ "$hl_i" -lt 30 ]; do
    curl -fsS --max-time 3 "http://127.0.0.1:$hl_port$hl_path" >/dev/null 2>&1 && return 0
    hl_i=$((hl_i + 1))
    sleep 0.5
  done
  return 1
}
check_plugin() {
  cp_paseo=${SCK_PASEO_BIN:-/Applications/Paseo.app/Contents/Resources/bin/paseo}
  cp_json=$("$cp_paseo" plugin ls sck-company --json 2>/dev/null) || return 1
  printf '%s' "$cp_json" | "$PYTHON" -c 'import json, os, sys
rows = json.load(sys.stdin) or []
p = rows[0] if rows else {}
path = p.get("path") or ""
ok = p.get("status") == "running" and p.get("enabled") is True and bool(path) and os.path.realpath(path) == os.path.realpath(sys.argv[1])
sys.exit(0 if ok else 1)' "$1/plugin"
}
# 验证：现役指向本快照、快照内容与提交一致、vendor schema、插件来源与健康检查。
verify_release() {
  vr_dir=$1
  vr_sha=$(basename "$vr_dir")
  vr_active=$(real_path "$service_home/active" 2>/dev/null) || vr_active=""
  if [ -z "$vr_active" ] || [ "$vr_active" != "$(real_path "$vr_dir")" ]; then
    echo "核验失败：现役版本不是 $vr_dir" >&2; return 1
  fi
  release_matches_commit "$vr_dir" "$vr_sha" "$ops_repo" || { echo "核验失败：快照内容与提交 $vr_sha 不一致" >&2; return 1; }
  diff -qr "$vr_dir/schema" "$vr_dir/plugin/server/vendor/schema" >/dev/null 2>&1 || { echo '核验失败：plugin vendor schema 与 schema 不一致' >&2; return 1; }
  check_plugin "$vr_dir" || { echo '核验失败：sck-company 插件来源或运行状态不符' >&2; return 1; }
  health "${SCK_MCP_PORT:-38473}" /health || { echo '核验失败：MCP /health 不通过' >&2; return 1; }
  health "${SCK_MCP_PORT:-38473}" /ready || { echo '核验失败：MCP /ready 不通过' >&2; return 1; }
  health "${SCK_PREVIEW_PORT:-18777}" /healthz || { echo '核验失败：预览 /healthz 不通过' >&2; return 1; }
  health "${SCK_PREVIEW_SIGNED_PORT:-18778}" /healthz || { echo '核验失败：签名预览 /healthz 不通过' >&2; return 1; }
  return 0
}
# 快照生成：在 staging 内完成全部步骤，只有完整后才 rename 进不可变的 releases/<sha>。
# 调用处在 if 条件中，set -e 不生效，因此每步显式返回失败。
build_snapshot() {
  bs_staging=$1; bs_previous=$2; bs_repo=$3; bs_sha=$4; bs_target=$5
  bs_source="$bs_staging/source"
  git -C "$bs_repo" archive --format=tar --output="$bs_staging/source.tar" "$bs_sha" || return 1
  mkdir "$bs_source" || return 1
  tar -xf "$bs_staging/source.tar" -C "$bs_source" || return 1
  cp -RL "$bs_previous/node_modules" "$bs_source/node_modules" || return 1
  cp -RL "$bs_previous/plugin/node_modules" "$bs_source/plugin/node_modules" || return 1
  sh "$bs_source/plugin/scripts/vendor.sh" || return 1
  mv "$bs_source" "$bs_target" || return 1
}

# 失败处理：切换前失败保持现役版本；切换后失败尝试恢复上一版本。最后一行输出结果。
fail() {
  fl_reason=$1
  if [ "$SWITCHED" = 1 ] && [ -n "$PREVIOUS" ]; then
    echo "切换后失败（${fl_reason}），尝试恢复上一版本" >&2
    if sh "$target/scripts/company-service.sh" install "$PREVIOUS" && verify_release "$PREVIOUS"; then
      printf '结果: 失败 原因=%s；已恢复上一版本 sha=%s\n' "$fl_reason" "$(basename "$PREVIOUS")"
    else
      printf '结果: 失败 原因=%s；恢复上一版本也失败，派工应保持暂停，请人工检查当前运行状态\n' "$fl_reason"
    fi
  else
    printf '结果: 失败 原因=%s；现役版本未切换，保持不变\n' "$fl_reason"
  fi
  exit 1
}

# 演练：只打印步骤，不做任何 git、文件或网络操作。
if [ "${SCK_RELEASE_INSTALL_DRY_RUN:-0}" = 1 ]; then
  echo "演练：提交 $sha 的安装步骤，只打印，不改动任何东西"
  echo '步骤 1：校验版本（提交须已在 origin/main 上，版本高于现役版本，company-release.json 与 package.json 一致）'
  echo "步骤 2：生成固定快照 ${target}（git archive、复制现役 node_modules、vendor.sh；已存在且与提交一致则复用）"
  echo '步骤 3：安装依赖并类型检查（根与 plugin 的 pnpm install --frozen-lockfile，plugin 加 --ignore-scripts；typecheck）'
  echo '步骤 4：本机发布门禁（comm-slow-pipe、sidecar-review；0.3.76 起加 recovery-fork）'
  echo '步骤 5：确认派工已暂停（需要 SCK_RELEASE_DISPATCH_PAUSED=1）'
  if [ -n "${COMPANY_DB_URL:-}" ]; then
    echo "步骤 6：调用公司库迁移 bun $target/scripts/company-migrate.ts"
  else
    echo '步骤 6：本机模式跳过迁移（未配置 COMPANY_DB_URL）'
  fi
  echo "步骤 7：切换现役版本：sh $target/scripts/company-service.sh install $target"
  echo '步骤 8：验证（现役指向、快照内容、vendor schema、插件来源、健康检查）；切换后失败则恢复上一版本'
  echo "结果: 演练完成 sha=${sha}，未改动任何东西"
  exit 0
fi

# ---- 以下为真实安装 ----
ops_repo=${SCK_OPS_REPO:-$(/usr/bin/sed -n 's/^SCK_AGENT_CWD=//p' "$service_home/private/service.env" 2>/dev/null | /usr/bin/tr -d "\"'")}
[ -n "$ops_repo" ] && [ -d "$ops_repo/.git" ] || fail '无法校验版本：请设置 SCK_OPS_REPO 为运营仓检出目录'

echo '步骤 1：校验版本'
git -C "$ops_repo" fetch origin main --quiet 2>/dev/null || fail 'git fetch origin main 失败'
git -C "$ops_repo" merge-base --is-ancestor "$sha" origin/main 2>/dev/null || fail "提交 $sha 不在 origin/main 上"
notes=$(git -C "$ops_repo" show "$sha:company-release.json" 2>/dev/null) || fail '无法读取 company-release.json'
pkg=$(git -C "$ops_repo" show "$sha:package.json" 2>/dev/null) || fail '无法读取 package.json'
version=$(printf '%s' "$notes" | "$PYTHON" -c 'import json, re, sys
notes = json.load(sys.stdin)
version = notes.get("version", "")
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version or ""):
    sys.exit(1)
if not all(isinstance(notes.get(k), str) and len(notes.get(k)) >= 2 for k in ("title", "migration", "rollback")):
    sys.exit(1)
print(version)') || fail 'company-release.json 缺少有效版本号或升级说明'
pkg_version=$(printf '%s' "$pkg" | "$PYTHON" -c 'import json, sys; print(json.load(sys.stdin).get("version", ""))' 2>/dev/null) || fail 'package.json 不可解析'
[ "$pkg_version" = "$version" ] || fail '版本说明与 package.json 版本不一致'

current_path=""; current_sha=""; current_version=""
if [ -e "$service_home/active" ]; then
  current_path=$(real_path "$service_home/active") || fail '现役版本目录无法核验'
  current_sha=$(basename "$current_path")
  is_sha "$current_sha" || fail '现役版本目录无法核验'
  current_version=$(read_version "$current_path/package.json")
fi
[ -n "$current_path" ] && [ -n "$current_version" ] || fail '没有可核验的现役版本，无法升级'
if [ "$current_sha" = "$sha" ]; then
  echo "提交 $sha 已是现役版本，跳过切换，只做验证"
  SKIP_SWITCH=1
else
  [ "$(vcmp "$version" "$current_version")" -gt 0 ] || fail "目标版本 $version 不高于现役版本 $current_version"
  git -C "$ops_repo" merge-base --is-ancestor "$current_sha" "$sha" 2>/dev/null || fail "现役提交 $current_sha 不是目标提交的祖先"
fi

if [ "$SKIP_SWITCH" = 0 ]; then
  echo '步骤 2：生成固定快照'
  if [ -d "$target" ]; then
    release_matches_commit "$target" "$sha" "$ops_repo" || fail "已存在的快照 $target 与提交 $sha 内容不一致，未覆盖"
    echo "复用已完整的快照 $target"
  else
    mkdir -p "$service_home/releases" "$service_home/upgrades" || fail '无法创建服务目录下的 releases 或 upgrades'
    chmod 700 "$service_home/upgrades" || fail '无法设置 upgrades 目录权限'
    staging=$(mktemp -d "$service_home/upgrades/staging-XXXXXX") || fail '无法创建 staging 目录'
    if build_snapshot "$staging" "$current_path" "$ops_repo" "$sha" "$target"; then
      rm -rf "$staging"
    else
      rm -rf "$staging"
      fail '生成固定快照失败'
    fi
  fi

  echo '步骤 3：安装依赖并类型检查'
  sh "$target/plugin/scripts/vendor.sh" || fail 'vendor.sh 失败'
  pnpm --dir "$target" install --frozen-lockfile || fail '根目录依赖安装失败'
  pnpm --dir "$target/plugin" install --frozen-lockfile --ignore-scripts || fail 'plugin 依赖安装失败'
  pnpm --dir "$target" typecheck || fail '根目录类型检查失败'
  pnpm --dir "$target/plugin" typecheck || fail 'plugin 类型检查失败'

  echo '步骤 4：本机发布门禁'
  for gate in $(gates_for "$version"); do
    case "$gate" in comm-slow-pipe) gate_arg=slow-pipe;; *) gate_arg=$gate;; esac
    sh "$target/scripts/release-gate.sh" "$gate_arg" "$target" || fail "门禁 $gate 未通过"
  done

  echo '步骤 5：确认派工已暂停'
  [ "${SCK_RELEASE_DISPATCH_PAUSED:-}" = 1 ] || fail '派工尚未暂停：切换前需老板侧暂停派工，并以 SCK_RELEASE_DISPATCH_PAUSED=1 确认'

  echo '步骤 6：公司库迁移'
  if [ -n "${COMPANY_DB_URL:-}" ]; then
    . "$here/bun-runtime.sh"
    resolve_bun "$service_home"
    [ -f "$target/scripts/company-migrate.ts" ] || fail 'scripts/company-migrate.ts 不存在，无法迁移公司库'
    "$BUN" "$target/scripts/company-migrate.ts" || fail '公司库迁移失败'
    echo '公司库迁移完成'
  else
    echo '本机模式跳过迁移（未配置 COMPANY_DB_URL）'
  fi

  echo '步骤 7：切换现役版本'
  PREVIOUS=$current_path
  SWITCHED=1
  sh "$target/scripts/company-service.sh" install "$target" || fail 'company-service.sh install 失败'
fi

echo '步骤 8：验证'
verify_release "$target" || fail '验证未通过'
echo "结果: 成功 sha=$sha"
exit 0
