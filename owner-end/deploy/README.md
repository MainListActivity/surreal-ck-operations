# 老板端云主机后端发布

前端继续使用 `https://company.maplayer.top`。Cloudflare 边缘只代理同源 `/api/*` 到 `https://data.maplayer.top/__company_owner/api/*`；Caddy 去掉 `/__company_owner`，转发到 `127.0.0.1:39125`。不新增域名，不开放跨域 API，不改变 `data.maplayer.top` 原有 Magpie、数据库和产品路由。

本目录的接收器只管理 `sck-owner-backend.service` 和 `/opt/sck-owner/releases`，不修改系统单元、环境文件、Caddy、数据库或其他服务。系统配置由管理员首次安装；CI 仅能上传固定格式的代码包。发布接收器不启停 timer，防止首次迁移期间两端重复执行 cron。

## 产物与本地校验

在仓库根目录运行（输出目录必须为空）：

```sh
bun --no-env-file scripts/owner-backend-package.ts --out /tmp/owner-release --sha <40位小写提交SHA> --version <semver>
python3 -m unittest discover -s owner-end/deploy -p 'test_*.py' -v
```

打包使用 Bun 的 `target: bun`、依赖 bundle 和无 source map 模式，仅输出：

- `server.js`：API 与 LIVE/SSE 服务。
- `server-cron.js`：接收一个完整 cron 字符串，执行一次后退出。
- `manifest.json`：`schema: 1`、`sha`、`version`，以及两个 JS 文件的 `sha256` 和字节数 `size`。

接收器只接受未压缩、最多 20 MiB 的 tar。拒绝路径、目录、链接、设备、稀疏文件、扩展头、重复条目、尾部拼接内容和清单不符；不调用 `tar extract`，只将校验后的字节写入固定文件名。GNU tar 用 `--format=ustar`，避免平台扩展元数据。

```sh
tar --format=ustar -C /tmp/owner-release -cf /tmp/owner-release.tar server.js server-cron.js manifest.json
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes owner-deploy 'deploy <40位小写提交SHA> <semver>' < /tmp/owner-release.tar
```

CI 必须先证明同一 SHA 已进入 `main` 且 Quality gate 成功，并固定 SSH host key；不要把任意 PR 的产物交给生产部署密钥。接收器的 forced-command 是能力边界，不代替 GitHub 的分支与复核门禁。

## 首次安装（管理员执行，CI 不执行）

目标主机已有 Bun 1.3.11；先确认受信任 Bun 的路径、架构和版本，再复制到专用目录。以下命令中的凭证源仅表示安全文件路径，不将其内容写入命令或日志：

```sh
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sck-owner
sudo install -d -o root -g root -m 0755 /opt/sck-owner /opt/sck-owner/bin /opt/sck-owner/releases
sudo install -o root -g root -m 0755 /home/ubuntu/.bun/bin/bun /opt/sck-owner/bin/bun
sudo install -d -o root -g root -m 0700 /etc/sck-owner
sudo install -o root -g root -m 0600 /secure/path/backend.env /etc/sck-owner/backend.env
sudo install -o root -g root -m 0755 owner-end/deploy/receive-release.py /usr/local/sbin/sck-owner-deploy
sudo install -o root -g root -m 0644 owner-end/deploy/*.service owner-end/deploy/*.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/sck-owner-backend.service /etc/systemd/system/sck-owner-minute.service /etc/systemd/system/sck-owner-daily.service /etc/systemd/system/sck-owner-minute.timer /etc/systemd/system/sck-owner-daily.timer
sudo systemctl daemon-reload
```

`backend.env` 由 root 的 systemd 读取，再以 `sck-owner` 身份启动进程；不要为了服务用户读文件而放宽 0600。它应包含现有生产身份/数据库/业务配置、`OWNER_PROXY_KEY`（至少 32 个字符）和 `OWNER_PUBLIC_ORIGIN=https://company.maplayer.top`。按 `src/server-env.ts` 的白名单配置；生产不配置 `DEV_DB_ROOT_*`。`OWNER_PROXY_KEY` 若带引号，systemd 会剥掉；写入边缘 `wrangler secret put` 时必须用剥引号后的同一值，否则边缘请求全部 403。`OWNER_RELEASE_VERSION` / `OWNER_RELEASE_SHA` 不写这里，它们由接收器在每个版本的 `release.env` 中生成。

生产主机的部署公钥加在 `ubuntu` 用户的 `authorized_keys`，由 forced-command 经免密 sudo 以 root 运行接收器；仅使用新密钥，保留现有其他 key，不要输出私钥：

```text
restrict,command="sudo -n /usr/local/sbin/sck-owner-deploy \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 <专用公钥> sck-owner-ci
```

升级接收器时同步更新 `/usr/local/sbin/sck-owner-deploy`，并核对 sha256 与仓库一致。接收器从 `SSH_ORIGINAL_COMMAND` 读取唯一命令；也支持 forced-command 将它作为唯一参数传入，若两者不一致则拒绝。只允许精确的 `deploy <40位小写SHA> <semver>`，不接受额外参数、路径或任意 shell。限制 stdin 读取时间为 60 秒，完整接收后忽略 SIGHUP 以完成已开始的切换；服务操作不继承 SSH 环境，也不运行 shell。

首次发布后确认 `/healthz` 返回 `ok: true` 且 SHA/version 与产物完全一致，再启用开机启动：

```sh
sudo systemctl enable sck-owner-backend.service
curl --fail --silent http://127.0.0.1:39125/healthz
```

## Caddy 与 cron 切换顺序

在已有 `data.maplayer.top` site 中加入独立的 prefix handler，保留现有其他 handler：

```caddyfile
handle_path /__company_owner/* {
    reverse_proxy 127.0.0.1:39125
}
```

先 `caddy validate --config /etc/caddy/Caddyfile`，成功后 reload。不要配置 `flush_interval -1`：SSE 会自动 flush，负值会改变下游断开时上游请求的取消行为。边缘与后端间使用独立代理密钥，不把它发给浏览器；请求取消要传递到后端 LIVE 订阅。

1. 安装单元和环境文件，保持两个 timer 未启用；上传后端产物，验证 loopback 健康和代理密钥校验。
2. 配置并验证 Caddy 路由；验证数据源和同源 edge 代理，再切换静态/edge 发布。
3. 确认旧 Worker scheduled 入口已关闭，才运行 `sudo systemctl enable --now sck-owner-minute.timer sck-owner-daily.timer`。
4. 核验 `systemctl list-timers 'sck-owner-*'`、两个 oneshot 的退出结果，以及实际业务状态；后续普通代码发布不改 timer 的启用状态。

两个 timer 均 `Persistent=true`，恢复时只补一次触发，不补跑每个错过的分钟。分钟表达式为 `* * * * *`；每日为 UTC 19:30，对应 `30 19 * * *`。两个 oneshot 共享 `/var/lib/sck-owner-cron/cron.lock`：分钟任务遇锁跳过，当日任务等待最多 300 秒，超时明确失败。systemd 本身不会并行启动同一 service；单次分钟任务最多 180 秒、每日最多 900 秒（含锁等待），无无限重试。

## 发布结果、回滚和资源边界

接收器在全量校验后取非阻塞发布锁，把四个固定文件（含 `release.env`）写到 root 持有的临时目录，再原子移到 `releases/<sha>`。相同 SHA 只允许字节完全相同的重试。随后原子切换 `current`，仅重启 `sck-owner-backend.service`，最多 30 秒等待 `/healthz` 返回正确版本。每次明确的发布/回滚重启先对该服务 `reset-failed`，避免坏版本耗尽启动次数后连旧版本也无法启动。初次失败撤销 `current` 并停止后端；升级失败恢复旧指针、重启并验证旧版本。若旧版本也不健康，明确报告恢复未通过，不冒充回滚成功。发布脚本不会删除历史版本，也不会修改或展示环境文件。

手动回滚通过同一个 forced-command 重新提交上一个已批准 SHA 的相同产物，重新执行健康验证，不接受客户端传路径。若 SSH 连接中断，先读取 loopback `/healthz` 和 `current` 判断实际结果；不要仅凭 CI 断线推断发布失败。root 可读取 systemd 状态，但不要将含凭证的环境或原始业务日志贴入证据。

后端仅绑定 loopback，用户无 shell、无 Linux capabilities，文件系统只读，服务失败最多每 60 秒重试 3 次。后端 `MemoryHigh=384M` / `MemoryMax=768M`、`CPUQuota=100%`（最多一个 CPU）；cron `256M` / `512M`、`CPUQuota=50%`。这些限制只影响新服务。`MemoryDenyWriteExecute` 未启用，因为 Bun/JSC 需要 JIT；不对现有数据库、Magpie、Hono 施加新限制。

常规切换时已运行的 cron 允许自然结束，它加载的是启动时版本；新触发读取新 `current`。若版本包含不兼容数据库迁移，应另行设计迁移门禁，不能借本接收器隐式执行。
