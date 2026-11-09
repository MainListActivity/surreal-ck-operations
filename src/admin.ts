import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { LocalEnrollmentAdmin } from './enrollment.ts';
import { SEED_DEFS } from './seed.ts';
import { effectiveWeight, Workforce } from './workforce.ts';
import { jevFromEnv } from './dispatcher/jev.ts';
import { parseReclaimCliArgs } from './dispatcher/artifact-reclaim.ts';
import { loadSecretKey, ProjectStore, type ProjectInput } from './projects.ts';
import { canonicalAlias, accountUsername, passwordSecretName } from './ops/accounts.ts';
import { cloudflareD1 } from './ops/d1.ts';
import { passwordLogin } from './ops/idp.ts';
import { controlPlaneEnv } from './ops/config.ts';
import type { BrokerConfig } from './ops/config.ts';
import { assertTaskExists, issueRemoteGrant, listRemoteGrants, REMOTE_OPERATOR_CHANNEL, revokeRemoteGrant, timedFetch, validateRemoteBlock } from './ops/remote-grant.ts';
import type { Role } from './contracts.ts';
import { CompanyError } from './core-errors.ts';
import { installNodeHost } from './host-node.ts';

installNodeHost();

const usage = `Usage: pnpm run admin <command>
  revoke <employee-id>                    撤销身份
  def list                                列出员工定义（含权重）
  def set <id> <role> <provider> <model> [thinking] [max-instances] [priority] [weight]
  def weight <id> <n>                     调整派工权重（0-1000，0=不主动派工；概率按权重占比）
  def tracks <id> <轨,轨|->               限定编制的岗位轨（- 或空 = 全接；非空则只接 discipline 在列的任务）
  def enable|disable <id>
  def quota <id> limited|unlimited     是否受订阅额度限制（unlimited = 剩余额度为 0 也继续派工）
  seed-defs                               写入默认员工定义（七个岗位各接 codex/grok/devin 订阅，另加 screenwriter-agy、story-author-agy（antigravity 单座）、cinematography-codex（codex 单座），已存在则不覆盖）
  inst list                               列出在职员工实例
  bind <employee-id> <paseo-agent-id> [def-id]
  retire <employee-id> <reason>           退役实例并撤销凭证
  jev-test                                测试 Jev 决策模型连通性（需 JEV_API_KEY）
  project set <file.json>                 写入/更新项目环境（结构见 docs/agent-operations.md）
  project list                            列出项目环境与凭证名（不含值）
  project lengths <项目>                   只读展示项目公开文本的 UTF-8 字节/计数与上限（不含正文）
  project check <file.json>               只读校验候选项目输入，不写库
  project broker <项目> <环境> <file.json>
                                          写入该环境的运维代理（ops broker）配置；只放非敏感项，校验不过不入库
  secret set <项目> <环境> <名称> <角色,角色|-> [用途]
                                          从标准输入读取凭证值，加密后入库（值不回显、不进参数）；
                                          凭证只有运维代理能解密，员工拿不到（角色仅作清单标签，- 表示无）
  config <key> <json-value>               修改 company_meta:config（如 max_running 4、jev_notify_triage false）
  reclaim-artifacts [--execute] [任务ID] [目标空闲MB]
                                          回收终态任务的大文件（evidence/deliverables）；
                                          缺省只演练不删，加 --execute 才真正动手，带目标 MB 则按压力模式回收`;

const [action, ...args] = process.argv.slice(2);
if (!action) throw new Error(usage);
const database = new CompanyDatabase(loadDatabaseConfig());
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  await database.connect();
  await database.bootstrap();
  const admin = new LocalEnrollmentAdmin(database);
  const workforce = new Workforce(database);
  switch (action) {
    case 'revoke': {
      // The same gate as retirement (LocalEnrollmentAdmin.revoke): a refusal writes nothing and exits non-zero with its stable code.
      try {
        await admin.revoke(args[0]!);
      } catch (error) {
        if (!(error instanceof CompanyError) || error.code !== 'retire_refused') throw error;
        print({ action, employeeId: args[0], ok: false, code: error.code, message: error.message, details: error.details });
        process.exitCode = 1;
        break;
      }
      print({ action, employeeId: args[0], ok: true });
      break;
    }
    case 'def': {
      const [sub, defId, ...rest] = args;
      if (sub === 'list') {
        print((await workforce.defs()).map(d => ({ id: d.id, role: d.role, provider: d.provider, model: d.model,
          thinking: d.thinking, tracks: d.tracks ?? [], enabled: d.enabled, max: d.maxInstances, weight: d.weight,
          quotaLimited: d.quotaLimited !== false,
          effectiveWeight: Number(effectiveWeight(d).toFixed(2)),
          errorStreak: d.errorStreak })));
        break;
      }
      if (sub === 'set') {
        const [role, provider, model, thinking, max, priority, weight] = rest;
        if (!defId || !role || !provider || !model) throw new Error(usage);
        await workforce.upsertDef(defId, { role: role as Role, provider, model, thinking: thinking || undefined,
          maxInstances: max ? Number(max) : undefined, priority: priority ? Number(priority) : undefined,
          weight: weight ? Number(weight) : undefined });
      } else if (sub === 'weight') {
        if (!defId || rest[0] === undefined) throw new Error(usage);
        await database.db.query('UPDATE $def SET weight = $weight;',
          { def: new RecordId('employee_def', defId), weight: Number(rest[0]) });
      } else if (sub === 'tracks') {
        if (!defId || rest[0] === undefined) throw new Error(usage);
        const tracks = rest[0] === '-' ? [] : rest.join(' ').split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        await database.db.query('UPDATE $def SET tracks = $tracks;',
          { def: new RecordId('employee_def', defId), tracks });
      } else if (sub === 'quota') {
        if (!defId || !['limited', 'unlimited'].includes(rest[0] ?? '')) throw new Error(usage);
        await database.db.query('UPDATE $def SET quota_limited = $q;',
          { def: new RecordId('employee_def', defId), q: rest[0] === 'limited' });
      } else if (sub === 'enable' || sub === 'disable') {
        await database.db.query('UPDATE $def SET enabled = $enabled, error_streak = 0, disabled_reason = NONE, disabled_at = NONE;',
          { def: new RecordId('employee_def', defId!), enabled: sub === 'enable' });
      } else throw new Error(usage);
      print(await workforce.defs());
      break;
    }
    case 'jev-test': {
      const jev = jevFromEnv();
      if (!jev) { console.log('未配置 JEV_API_KEY / TYPESAFE_API_KEY（service.env）；Jev 评审通道未启用'); break; }
      const started = Date.now();
      const result = await jev.ask('公司今早的巡检一切正常。', {
        ok: { type: 'noul', instructions: '这句话是不是一个肯定陈述' },
        tone: { type: 'score', instructions: '这句话的正式程度', criteria: ['口语随意', '中性', '正式'] },
      });
      console.log(`jev ${result.model} 应答正常（${Date.now() - started}ms）:`);
      print(result.answers);
      break;
    }
    case 'seed-defs': {
      const existing = new Set((await workforce.defs()).map(d => d.id));
      for (const def of SEED_DEFS) if (!existing.has(def.id)) await workforce.upsertDef(def.id, def);
      print((await workforce.defs()).map(d => `${d.id} ${d.provider}/${d.model} ${d.thinking ?? ''} max=${d.maxInstances}`));
      break;
    }
    case 'inst': {
      print(await workforce.insts());
      break;
    }
    case 'bind': {
      const [employeeId, agentId, defId] = args;
      if (!employeeId || !agentId) throw new Error(usage);
      const def = defId ? (await workforce.defs()).find(d => d.id === defId) : undefined;
      if (defId && !def) throw new Error('Unknown def');
      await workforce.bind(employeeId, { agentId, def: def?.id, provider: def?.provider, model: def?.model,
        thinking: def?.thinking });
      print({ action, employeeId, agentId, def: def?.id, ok: true });
      break;
    }
    case 'retire': {
      // The same gate as every other retirement (workforce.retire): a refusal writes nothing and exits non-zero with its stable code.
      try {
        await workforce.retire(args[0]!, args.slice(1).join(' ') || 'manual', 'manual');
      } catch (error) {
        if (!(error instanceof CompanyError) || error.code !== 'retire_refused') throw error;
        print({ action, employeeId: args[0], ok: false, code: error.code, message: error.message, details: error.details });
        process.exitCode = 1;
        break;
      }
      print({ action, employeeId: args[0], ok: true });
      break;
    }
    case 'project': {
      const [sub, first, second, third] = args;
      const store = new ProjectStore(database.db);
      if (sub === 'list') print(await store.list());
      else if (sub === 'set' && first) print(await store.upsert(JSON.parse(readFileSync(first, 'utf8')) as ProjectInput));
      else if (sub === 'lengths' && first) {
        const lengths = await store.textLengths(first);
        if (!lengths) throw new CompanyError('not_found', `project ${first} not found`);
        print({ action: 'project lengths', project: first, ...lengths });
      } else if (sub === 'check' && first) {
        const input = JSON.parse(readFileSync(first, 'utf8')) as ProjectInput;
        print({ action: 'project check', ...(await store.checkInput(input)) });
      } else if (sub === 'broker' && first && second && third) {
        const brokerJson = JSON.parse(readFileSync(third, 'utf8'));
        if (brokerJson?.remote !== undefined) validateRemoteBlock(brokerJson.remote);
        await store.setBroker(first, second, brokerJson);
        print({ action: 'project broker', project: first, env: second, ok: true });
      } else throw new Error(usage);
      break;
    }
    case 'secret': {
      const [sub, project, env, name, roles, ...purpose] = args;
      if (sub !== 'set' || !project || !env || !name || !roles) throw new Error(usage);
      const labels = roles === '-' ? [] : roles.split(',') as Role[];
      const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      await new ProjectStore(database.db).setSecret({ project, env, name, value, roles: labels,
        purpose: purpose.join(' ') || undefined }, loadSecretKey(true));
      print({ action, project, env, name, roles: labels, ok: true });
      break;
    }
    case 'config': {
      const [key, value] = args;
      if (!key || value === undefined || !/^[a-z_]+$/.test(key)) throw new Error(usage);
      await database.db.query('UPSERT company_meta:config MERGE $patch;', { patch: { [key]: JSON.parse(value) } });
      print(await workforce.config());
      break;
    }
    case 'remote-grant': {
      const [sub, ...rest] = args;
      const opts: { alias?: string; days?: number; content?: boolean; purge?: boolean; attach?: boolean; env: string; project: string; task?: string; grantId?: string } = { env: 'production', project: 'surreal_ck' };
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i]!;
        if (a === '--alias') opts.alias = rest[++i];
        else if (a === '--days') opts.days = Number(rest[++i]);
        else if (a === '--content') opts.content = true;
        else if (a === '--purge') opts.purge = true;
        else if (a === '--attach') opts.attach = true;
        else if (a === '--env') opts.env = rest[++i]!;
        else if (a === '--project') opts.project = rest[++i]!;
        else if (a === '--task') opts.task = rest[++i];
        else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        else positional.push(a);
      }
      const store = new ProjectStore(database.db);
      const envRow = (await store.brokerEnvs(opts.project)).find((r) => r.name === opts.env);
      const cfg = (envRow as { broker?: unknown } | undefined)?.broker as BrokerConfig | undefined;
      if (!cfg) throw new CompanyError('not_configured', `project ${opts.project}/${opts.env} has no broker config`);
      if (cfg.remote) validateRemoteBlock(cfg.remote);
      const controlEnv = controlPlaneEnv();
      const rglog = (m: string) => console.error(`[remote-grant ${new Date().toISOString().slice(11, 19)}] ${m}`);
      const fetch30 = timedFetch(fetch, 30_000);
      const d1 = cloudflareD1({
        accountId: controlEnv.cloudflareAccountId ?? '',
        databaseId: cfg.d1?.databaseId ?? '',
        token: controlEnv.cloudflareToken ?? '',
        fetch: fetch30,
      });
      const secretKey = loadSecretKey(false);
      const sealedPassword = async (alias: string) =>
        store.readSealed(opts.project, opts.env, passwordSecretName(alias), secretKey);
      const sealPassword = async (alias: string, password: string) => {
        await store.setSecret({ project: opts.project, env: opts.env, name: passwordSecretName(alias), value: password, roles: [] }, secretKey);
      };
      const loginFor = async (alias: string, channel: 'customer' | 'ops' | 'operator') => {
        const password = await sealedPassword(alias);
        if (!password) throw new CompanyError('not_configured', `no sealed password for alias ${alias}; run ops_account_ensure first`);
        const username = accountUsername(alias, cfg.accounts.prefix);
        rglog(`passwordLogin ${username} channel=${channel}`);
        const tokens = await passwordLogin(cfg, username, password, { channel, fetch: fetch30 });
        return tokens.accessToken;
      };
      const audit = async (action: string, evidence: string) => {
        console.error(`[remote-grant-audit] ${action} ${evidence}`);
      };

      if (sub === 'issue') {
        const taskId = positional[0] ?? opts.task;
        if (!taskId || !opts.alias) throw new Error('remote-grant issue <taskId> --alias <A> [--days 30] [--content] [--env production] [--attach]');
        await assertTaskExists(database.db, taskId);
        rglog('task exists; issuing');
        const result = await issueRemoteGrant(
          { d1, fetch: fetch30, sealedPassword, sealPassword, operatorToken: () => loginFor(canonicalAlias(cfg.remote!.testManagerAlias), REMOTE_OPERATOR_CHANNEL), audit },
          { cfg, taskId, alias: opts.alias, ...(opts.days !== undefined ? { days: opts.days } : {}), content: opts.content === true },
        );
        rglog('issue complete');
        // url（含一次性码）只出现在 stdout，仅此一次可见；其余信息走 stderr。
        console.error(JSON.stringify({ grantId: result.grantId, expiresAt: result.expiresAt, workspaceSlug: result.workspaceSlug, subject: result.subject }));
        if (opts.attach) {
          const block = `

【远程会话】兑换链接：${result.url}
在 VPS 上执行：bun scripts/remote-session.ts redeem '<链接>'
之后 bun scripts/remote-session.ts token 取 access token、db <slug> 取 DB token（详见 surreal_ck docs/runbooks/remote-vps-session.md）。
`;
          await database.db.query(
            `UPDATE type::thing('task', $taskId) SET context = (context ?? '') + $block;`,
            { taskId, block });
          console.error('说明块已追加到任务 context（含一次性码明文：码一次性、TTL ≤7 天）。');
        }
        console.log(result.url);
      } else if (sub === 'revoke') {
        const grantId = positional[0] ?? opts.grantId;
        const result = await revokeRemoteGrant(
          { d1, fetch: fetch30, operatorToken: () => loginFor(canonicalAlias(cfg.remote!.testManagerAlias), REMOTE_OPERATOR_CHANNEL), audit },
          { cfg, ...(grantId !== undefined ? { grantId } : {}), ...(opts.task !== undefined ? { taskId: opts.task } : {}), purge: opts.purge === true },
        );
        print(result);
      } else if (sub === 'list') {
        print(await listRemoteGrants({ d1 }, { cfg, ...(opts.task !== undefined ? { taskId: opts.task } : {}) }));
      } else throw new Error('remote-grant: unknown subcommand (issue|revoke|list)');
      break;
    }
    case 'reclaim-artifacts': {
      // Operator entry for terminal-task artifact reclaim: dry-run by default, `--execute` to
      // actually trim. SCK_ARTIFACT_RECLAIM=0 does not block an explicit operator run.
      // A bare number is a free-disk target, never a task id (see parseReclaimCliArgs).
      const { execute, taskId, targetFreeMb } = parseReclaimCliArgs(args);
      const { ArtifactReclaimer, dbArtifactTasks, summarizeReclaim } = await import('./dispatcher/artifact-sweeper.ts');
      const { hostResources } = await import('./dispatcher/host.ts');
      const home = process.env.SCK_SERVICE_HOME ?? join(homedir(), 'Library/Application Support/SurrealCKCompany');
      const reclaimer = new ArtifactReclaimer({
        home,
        tasks: dbArtifactTasks(database.db),
        config: async () => {
          const cfg = await workforce.config();
          return {
            artifactReclaimEnabled: cfg.artifactReclaimEnabled,
            artifactEvidenceGraceDays: cfg.artifactEvidenceGraceDays,
            artifactDeliverableGraceDays: cfg.artifactDeliverableGraceDays,
            artifactHeadroomMb: cfg.artifactHeadroomMb,
            minFreeDiskMb: cfg.minFreeDiskMb,
          };
        },
        freeDiskMb: () => hostResources(home).freeDiskMb,
        env: process.env,
      });
      const result = await reclaimer.reclaim({
        trigger: execute ? 'manual' : 'dry_run',
        dryRun: !execute,
        targetFreeMb,
        taskId,
        maxMs: 300_000,
      });
      print({ ...result, summary: summarizeReclaim(result), run: execute ? 'execute' : 'dry-run' });
      break;
    }
    default:
      throw new Error(usage);
  }
} finally {
  await database.close();
}
