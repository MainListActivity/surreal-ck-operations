import { chmodSync, mkdirSync, openSync, readFileSync, writeSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { LocalEnrollmentAdmin } from './enrollment.ts';
import { SEED_DEFS } from './seed.ts';
import { capabilitiesFor, effectiveWeight, Workforce } from './workforce.ts';
import { jevFromEnv } from './dispatcher/jev.ts';
import { loadSecretKey, ProjectStore, type ProjectInput } from './projects.ts';
import type { Role } from './contracts.ts';

const usage = `Usage: pnpm run admin <command>
  enroll <employee-id> <role>             登记固定身份（写入本 checkout .runtime/credentials）
  revoke <employee-id>                    撤销身份
  def list                                列出员工定义（含权重与绩效均分）
  def set <id> <role> <provider> <model> [thinking] [max-instances] [priority] [weight]
  def weight <id> <n>                     调整派工权重（0-1000，0=不主动派工；概率按权重占比）
  def enable|disable <id>
  seed-defs                               写入默认员工定义（codex/grok/devin × 九岗位含 eval，已存在则不覆盖）
  inst list                               列出在职员工实例
  bind <employee-id> <paseo-agent-id> [def-id] [credential-file]
  retire <employee-id> <reason>           退役实例并撤销凭证
  scores [任务ID]                          查看绩效评分记录（默认最近 50 条）
  jev-test                                测试 Jev 决策模型连通性（需 JEV_API_KEY）
  project set <file.json>                 写入/更新项目环境（结构见 docs/agent-operations.md）
  project list                            列出项目环境与凭证名（不含值）
  project broker <项目> <环境> <file.json>
                                          写入该环境的运维代理（ops broker）配置；只放非敏感项，校验不过不入库
  secret set <项目> <环境> <名称> <角色,角色|-> [用途]
                                          从标准输入读取凭证值，加密后入库（值不回显、不进参数）；
                                          凭证只有运维代理能解密，员工拿不到（角色仅作清单标签，- 表示无）
  config <key> <json-value>               修改 company_meta:config（如 max_running 4、eval_enabled false）`;

const [action, ...args] = process.argv.slice(2);
if (!action) throw new Error(usage);
const database = new CompanyDatabase(loadDatabaseConfig());
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  await database.connect();
  await database.bootstrap();
  const admin = new LocalEnrollmentAdmin(database);
  const workforce = new Workforce(database, resolve(process.env.SCK_CREDENTIAL_DIR ?? join(import.meta.dir, '..', '.runtime', 'credentials')));
  switch (action) {
    case 'revoke': {
      await admin.revoke(args[0]!);
      print({ action, employeeId: args[0], ok: true });
      break;
    }
    case 'enroll': {
      const [employeeId, roleArg] = args;
      if (!employeeId) throw new Error(usage);
      const role = roleArg as Role;
      const directory = join(import.meta.dir, '..', '.runtime', 'credentials');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const path = join(directory, `${employeeId}.token`);
      if (existsSync(path)) throw new Error('Credential file already exists; revoke and archive it before replacement');
      const credential = await admin.enroll(employeeId, role, capabilitiesFor(role));
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, credential); } finally { closeSync(fd); }
      print({ action, employeeId, path, ok: true });
      break;
    }
    case 'def': {
      const [sub, defId, ...rest] = args;
      if (sub === 'list') {
        print((await workforce.defs()).map(d => ({ id: d.id, role: d.role, provider: d.provider, model: d.model,
          thinking: d.thinking, enabled: d.enabled, max: d.maxInstances, weight: d.weight,
          effectiveWeight: Number(effectiveWeight(d).toFixed(2)),
          avgScore: d.avgScore ? Number(d.avgScore.toFixed(2)) : undefined, scored: d.scored,
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
    case 'scores': {
      const taskId = args[0];
      print((await database.db.query<unknown[]>(
        taskId ? 'SELECT * FROM scorecard WHERE task = $task ORDER BY at DESC LIMIT 50;'
          : 'SELECT * FROM scorecard ORDER BY at DESC LIMIT 50;',
        { task: taskId ? new RecordId('task', taskId) : undefined }))[0]);
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
      const [employeeId, agentId, defId, credentialFile] = args;
      if (!employeeId || !agentId) throw new Error(usage);
      const def = defId ? (await workforce.defs()).find(d => d.id === defId) : undefined;
      if (defId && !def) throw new Error('Unknown def');
      await workforce.bind(employeeId, { agentId, def: def?.id, provider: def?.provider, model: def?.model,
        thinking: def?.thinking, credentialFile });
      print({ action, employeeId, agentId, def: def?.id, ok: true });
      break;
    }
    case 'retire': {
      await workforce.retire(args[0]!, args.slice(1).join(' ') || 'manual');
      print({ action, employeeId: args[0], ok: true });
      break;
    }
    case 'project': {
      const [sub, first, second, third] = args;
      const store = new ProjectStore(database.db);
      if (sub === 'list') print(await store.list());
      else if (sub === 'set' && first) print(await store.upsert(JSON.parse(readFileSync(first, 'utf8')) as ProjectInput));
      else if (sub === 'broker' && first && second && third) {
        await store.setBroker(first, second, JSON.parse(readFileSync(third, 'utf8')));
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
    default:
      throw new Error(usage);
  }
} finally {
  await database.close();
}
