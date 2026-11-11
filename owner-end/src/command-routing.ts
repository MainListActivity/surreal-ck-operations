/**
 * 哪些老板命令必须由服务端执行：读服务端配置或调外部服务的命令（身份、员工策略与按目标锁、译文、Cloudflare），
 * 以及带“译文未就绪不放行”门的消息命令。其余老板命令在页面里用老板令牌直连执行（见 ui/source.ts）。
 * 本模块不依赖任何业务模块，页面首屏即可判断；tests/command-routing.test.ts 核对它覆盖 commands.ts 里所有读配置的分支。
 */
export const BACKEND_OWNER_COMMANDS: ReadonlySet<string> = new Set([
  // 身份（ma_hono 管理接口）
  'idp.status', 'idp.tenant.create', 'idp.client.ensure', 'idp.client.create', 'idp.client.reset', 'idp.client.reset_secret',
  'idp.client.claims.set', 'idp.user.list_agents', 'idp.request', 'agent.identity.ensure', 'agent.create',
  // 员工策略与按目标锁（读 cfg.locks）
  'agent.list', 'agent.policy.list', 'agent.policy.set', 'guard.list', 'guard.protect', 'guard.unprotect', 'guard.set',
  // 译文（magpie）
  'translate.preview', 'translate.message',
  // Cloudflare
  'cf.api',
  // 保存或放行前要补译的消息命令
  'message.edit', 'message.edit_rendered', 'message.release', 'message.send',
]);
