#!/bin/sh
set -eu

# 安装、更新与卸载节点更新器（node-updater.js）的定时任务。
#   install [--from <dir>] [--no-load]  安装或更新（幂等）；--from 与 --no-load 仅用于测试与离线安装
#   run                                 立即执行一轮（调用 <home>/updater/run.sh）
#   status                              显示定时任务是否已加载，并打印日志最后 40 行
#   uninstall                           卸载定时任务并删除 plist/unit；保留 plugin-releases 与日志
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
updater_dir="$service_home/updater"
logs_dir="$service_home/logs"
plugin_releases_dir="$service_home/plugin-releases"
log_file="$logs_dir/node-updater.log"
run_sh="$updater_dir/run.sh"
bundle_file="$updater_dir/node-updater.js"
label="org.surrealck.node-updater"
release_repo=${SCK_RELEASE_REPO:-MainListActivity/surreal-ck-operations}
domain="gui/$(id -u)"
systemd_service="sck-node-updater.service"
systemd_timer="sck-node-updater.timer"
systemd_dir="$HOME/.config/systemd/user"

usage() {
  cat >&2 <<'EOF'
用法：
  sh scripts/node-updater.sh install [--from <dir>] [--no-load]   安装或更新节点更新器（幂等）
  sh scripts/node-updater.sh run                                  立即执行一轮检查与升级
  sh scripts/node-updater.sh status                               查看定时任务状态并打印日志最后 40 行
  sh scripts/node-updater.sh uninstall                            卸载定时任务（保留 plugin-releases 与日志）
EOF
}

die() {
  echo "错误：$*" >&2
  exit 1
}

# 把任意字符串转义为单引号包裹的 shell 字面量（' 替换为 '\''）。
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# 把路径转义为 systemd ExecStart 中双引号包裹的字面量（反斜杠、双引号、百分号）。
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g')"
}

platform() {
  uname -s
}

# 等待 launchd 任务完全退出，避免 bootout 异步完成前 bootstrap 失败（EIO）。
launchd_unload() {
  launchctl bootout "$domain/$label" 2>/dev/null || true
  i=0
  while launchctl print "$domain/$label" >/dev/null 2>&1 && [ "$i" -lt 50 ]; do
    sleep 0.2
    i=$((i + 1))
  done
}

plist_path() {
  echo "$HOME/Library/LaunchAgents/$label.plist"
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents"
  SCK_PLIST_PATH="$(plist_path)" SCK_PLIST_LABEL="$label" SCK_PLIST_RUN_SH="$run_sh" SCK_PLIST_LOG="$log_file" \
    /usr/bin/python3 - <<'PY'
import os, plistlib
from pathlib import Path
payload = {
    'Label': os.environ['SCK_PLIST_LABEL'],
    'ProgramArguments': [os.environ['SCK_PLIST_RUN_SH']],
    'RunAtLoad': True,
    'StartInterval': 900,
    'StandardOutPath': os.environ['SCK_PLIST_LOG'],
    'StandardErrorPath': os.environ['SCK_PLIST_LOG'],
}
path = Path(os.environ['SCK_PLIST_PATH'])
tmp = path.with_name(path.name + '.tmp')
tmp.write_bytes(plistlib.dumps(payload))
tmp.chmod(0o600)
os.replace(tmp, path)
PY
}

write_systemd_units() {
  mkdir -p "$systemd_dir"
  svc_tmp="$systemd_dir/.$systemd_service.tmp.$$"
  tmr_tmp="$systemd_dir/.$systemd_timer.tmp.$$"
  {
    printf '%s\n' '[Unit]' 'Description=SurrealCK 节点更新器' '' '[Service]' 'Type=oneshot'
    printf 'ExecStart=%s\n' "$(systemd_quote "$run_sh")"
  } > "$svc_tmp"
  {
    printf '%s\n' '[Unit]' 'Description=SurrealCK 节点更新器定时器' '' '[Timer]' \
      'OnBootSec=2min' 'OnUnitActiveSec=15min' 'Persistent=true' '' '[Install]' 'WantedBy=timers.target'
  } > "$tmr_tmp"
  chmod 644 "$svc_tmp" "$tmr_tmp"
  mv "$svc_tmp" "$systemd_dir/$systemd_service"
  mv "$tmr_tmp" "$systemd_dir/$systemd_timer"
}

# 解析并检查 node、tar、pnpm、gh 与 Paseo CLI。结果写入 node_bin、pnpm_bin、paseo_bin。
check_tools() {
  use_from=$1
  node_bin=$(command -v "${SCK_NODE_BIN:-node}" 2>/dev/null || true)
  case "$node_bin" in
    /*) ;;
    *) die "未找到 node（请安装 Node.js 22 或以上版本，或设置 SCK_NODE_BIN 为 node 的绝对路径）" ;;
  esac
  node_ver=$("$node_bin" -p 'process.versions.node' 2>/dev/null || true)
  node_ver=${node_ver#v}
  node_major=${node_ver%%.*}
  case "$node_major" in
    ''|*[!0-9]*) die "无法读取 node 版本：$node_bin" ;;
  esac
  [ "$node_major" -ge 22 ] || die "node 版本过低（当前 v$node_ver，需要 22 或以上）：$node_bin"

  command -v tar >/dev/null 2>&1 || die "未找到 tar"

  pnpm_bin=$(command -v "${SCK_PNPM_BIN:-pnpm}" 2>/dev/null || true)
  case "$pnpm_bin" in
    /*) ;;
    *) die "未找到 pnpm（请安装 pnpm，或设置 SCK_PNPM_BIN 为 pnpm 的绝对路径）" ;;
  esac

  if [ "$use_from" -eq 0 ]; then
    command -v gh >/dev/null 2>&1 || die "未找到 gh（GitHub CLI）；生产安装需要 gh 以下载并校验发行资产"
  fi

  paseo_bin=${SCK_PASEO_BIN:-}
  if [ -z "$paseo_bin" ]; then
    if [ "$(platform)" = "Darwin" ] && [ -x /Applications/Paseo.app/Contents/Resources/bin/paseo ]; then
      paseo_bin=/Applications/Paseo.app/Contents/Resources/bin/paseo
    else
      paseo_bin=$(command -v paseo 2>/dev/null || true)
    fi
  fi
  if [ -z "$paseo_bin" ]; then
    echo "警告：未找到 Paseo CLI（paseo），节点更新器的 Paseo 相关功能将不可用，请安装 Paseo 后再使用。" >&2
  fi
}

# 校验 manifest.json 与 node-updater.js。失败时中文报错并退出。
verify_bundle() {
  manifest_path=$1
  bundle_path=$2
  "$node_bin" -e '
const fs = require("fs");
const crypto = require("crypto");
const [manifestPath, bundlePath] = process.argv.slice(1);
function fail(msg) { process.stderr.write(msg + "\n"); process.exit(1); }
let m;
try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (e) { fail("错误：manifest.json 无法解析：" + e.message); }
if (!m || typeof m !== "object") fail("错误：manifest.json 格式不正确");
if (m.format !== 1) fail("错误：manifest.json 的 format 必须为 1");
if (m.product !== "sck-company") fail("错误：manifest.json 的 product 必须为 sck-company");
for (const k of ["version", "sha", "requiredSchema", "createdAt"]) {
  if (m[k] === undefined || m[k] === null || m[k] === "") fail("错误：manifest.json 缺少字段 " + k);
}
const pkg = m.package;
if (!pkg || typeof pkg.name !== "string" || typeof pkg.sha256 !== "string" || typeof pkg.bytes !== "number") {
  fail("错误：manifest.json 的 package 字段不完整");
}
const upd = m.updater;
if (!upd || upd.name !== "node-updater.js" || typeof upd.sha256 !== "string" || typeof upd.bytes !== "number") {
  fail("错误：manifest.json 的 updater 字段不完整");
}
let buf;
try { buf = fs.readFileSync(bundlePath); } catch (e) { fail("错误：无法读取 node-updater.js：" + e.message); }
const sha = crypto.createHash("sha256").update(buf).digest("hex");
if (sha !== upd.sha256.toLowerCase()) fail("错误：node-updater.js 的 sha256 与 manifest 不符，已放弃安装");
if (buf.length !== upd.bytes) fail("错误：node-updater.js 的字节数与 manifest 不符，已放弃安装");
' "$manifest_path" "$bundle_path" || die "发行资产校验失败，未写入任何已安装文件"
}

# 生成 <home>/updater/run.sh（权限 700）。路径全部使用单引号转义。
write_run_sh() {
  rs_tmp="$updater_dir/.run.sh.tmp.$$"
  pnpm_dir=$(dirname "$pnpm_bin")
  node_dir=$(dirname "$node_bin")
  {
    printf '%s\n' '#!/bin/sh' 'set -eu'
    printf "PATH=%s\n" "$(sh_quote "$node_dir:$pnpm_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"'"${PATH:+:$PATH}"'
    printf '%s\n' 'export PATH'
    printf 'export SCK_SERVICE_HOME=%s\n' "$(sh_quote "$service_home")"
    if [ -n "${SCK_PASEO_BIN:-}" ]; then printf 'export SCK_PASEO_BIN=%s\n' "$(sh_quote "$SCK_PASEO_BIN")"; fi
    if [ -n "${SCK_PNPM_BIN:-}" ]; then printf 'export SCK_PNPM_BIN=%s\n' "$(sh_quote "$SCK_PNPM_BIN")"; fi
    if [ -n "${SCK_RELEASE_REPO:-}" ]; then printf 'export SCK_RELEASE_REPO=%s\n' "$(sh_quote "$SCK_RELEASE_REPO")"; fi
    # Output of a scheduled run goes to the per-run log on both platforms (systemd has no log file of its own).
    printf '%s\n' 'if [ ! -t 1 ]; then'
    printf '  exec >>%s 2>&1\n' "$(sh_quote "$log_file")"
    printf '%s\n' 'fi'
    printf 'exec %s %s run\n' "$(sh_quote "$node_bin")" "$(sh_quote "$bundle_file")"
  } > "$rs_tmp"
  chmod 700 "$rs_tmp"
  mv "$rs_tmp" "$run_sh"
}

install_cmd() {
  from_dir=""
  no_load=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --from)
        [ $# -ge 2 ] || { usage; die "--from 需要目录参数"; }
        from_dir=$2
        shift 2
        ;;
      --no-load)
        no_load=1
        shift
        ;;
      *)
        usage
        die "未知参数：$1"
        ;;
    esac
  done

  plat=$(platform)
  if [ "$no_load" -eq 0 ]; then
    case "$plat" in
      Darwin|Linux) ;;
      *) die "不支持的系统：$plat（仅支持 macOS 与 Linux）" ;;
    esac
  fi

  use_from=0
  [ -z "$from_dir" ] || use_from=1
  check_tools "$use_from"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/sck-node-updater.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT

  if [ "$use_from" -eq 1 ]; then
    src_dir=$from_dir
    [ -f "$src_dir/manifest.json" ] || die "缺少 $src_dir/manifest.json"
    [ -f "$src_dir/node-updater.js" ] || die "缺少 $src_dir/node-updater.js"
  else
    src_dir=$tmp
    echo "正在从 GitHub Release 下载节点更新器（$release_repo）..."
    gh release download --repo "$release_repo" --pattern manifest.json --pattern node-updater.js --dir "$tmp" --clobber \
      || die "从 GitHub Release 下载失败（仓库：$release_repo）"
    [ -f "$tmp/manifest.json" ] && [ -f "$tmp/node-updater.js" ] || die "Release 中缺少 manifest.json 或 node-updater.js"
  fi

  verify_bundle "$src_dir/manifest.json" "$src_dir/node-updater.js"

  mkdir -p "$service_home" "$updater_dir" "$logs_dir" "$plugin_releases_dir"
  chmod 700 "$service_home" "$updater_dir" "$logs_dir" "$plugin_releases_dir"

  bundle_tmp="$updater_dir/.node-updater.js.tmp.$$"
  cp "$src_dir/node-updater.js" "$bundle_tmp"
  chmod 600 "$bundle_tmp"
  mv "$bundle_tmp" "$bundle_file"
  echo "已安装节点更新器：$bundle_file"

  write_run_sh
  echo "已写入执行脚本：$run_sh"

  if [ "$no_load" -eq 1 ]; then
    echo "已跳过定时任务注册（--no-load）。"
    return 0
  fi

  if [ "$plat" = "Darwin" ]; then
    write_plist
    launchd_unload
    launchctl bootstrap "$domain" "$(plist_path)" || die "launchctl bootstrap 失败：$(plist_path)"
    echo "已注册 launchd 定时任务：$label（每 15 分钟一次）"
  else
    write_systemd_units
    systemctl --user daemon-reload || die "systemctl --user daemon-reload 失败"
    systemctl --user enable --now "$systemd_timer" || die "启用定时器失败：$systemd_timer"
    echo "已启用 systemd 定时器：$systemd_timer（每 15 分钟一次）"
    echo "提示：服务器上若无登录会话，需要执行 loginctl enable-linger \"\$USER\"，否则定时器不会在登出后运行。"
  fi

  echo "正在立即执行一轮节点更新检查..."
  sh "$run_sh" || echo "警告：首次执行失败，可稍后运行 sh scripts/node-updater.sh run 重试；安装本身已完成。" >&2
}

run_cmd() {
  [ -f "$run_sh" ] || die "节点更新器未安装（缺少 $run_sh），请先执行 install"
  exec sh "$run_sh"
}

status_cmd() {
  plat=$(platform)
  case "$plat" in
    Darwin)
      if launchctl print "$domain/$label" >/dev/null 2>&1; then
        echo "定时任务：已加载（$label）"
      else
        echo "定时任务：未加载（$label）"
      fi
      ;;
    Linux)
      state=$(systemctl --user is-enabled "$systemd_timer" 2>/dev/null || true)
      echo "定时任务：${state:-未安装}（$systemd_timer）"
      ;;
    *)
      echo "定时任务：不支持的系统 $plat"
      ;;
  esac
  if [ -f "$log_file" ]; then
    echo "--- 日志最后 40 行（$log_file）---"
    tail -n 40 "$log_file"
  else
    echo "日志不存在：$log_file"
  fi
}

uninstall_cmd() {
  plat=$(platform)
  case "$plat" in
    Darwin)
      launchctl bootout "$domain/$label" 2>/dev/null || true
      rm -f "$(plist_path)"
      echo "已卸载 launchd 定时任务：$label"
      ;;
    Linux)
      systemctl --user disable --now "$systemd_timer" 2>/dev/null || true
      rm -f "$systemd_dir/$systemd_service" "$systemd_dir/$systemd_timer"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "已卸载 systemd 定时任务：$systemd_timer"
      ;;
    *)
      die "不支持的系统：$plat（仅支持 macOS 与 Linux）"
      ;;
  esac
  echo "已保留 plugin-releases 与日志：$plugin_releases_dir，$logs_dir"
}

action=${1:-}
[ $# -eq 0 ] || shift
case "$action" in
  install) install_cmd "$@" ;;
  run)
    [ $# -eq 0 ] || { usage; die "run 不接受参数：$1"; }
    run_cmd
    ;;
  status) status_cmd ;;
  uninstall) uninstall_cmd ;;
  *)
    usage
    if [ -n "$action" ]; then die "未知命令：$action"; fi
    exit 2
    ;;
esac
