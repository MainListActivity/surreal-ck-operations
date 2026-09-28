import { chmodSync, mkdirSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecordId } from 'surrealdb';
import { loadDatabaseConfig } from './config.ts';
import { CompanyDatabase } from './database.ts';
import { LocalEnrollmentAdmin } from './enrollment.ts';
import { SEED_DEFS } from './seed.ts';
import { capabilitiesFor, Workforce } from './workforce.ts';
import type { Role } from './contracts.ts';

const usage = `Usage: pnpm run admin <command>
  enroll <employee-id> <role>             登记固定身份（写入本 checkout .runtime/credentials）
  revoke <employee-id>                    撤销身份
  def list                                列出员工定义
  def set <id> <role> <provider> <model> [thinking] [max-instances] [priority]
  def enable|disable <id>
  seed-defs                               写入默认员工定义（codex/grok/devin × 六岗位，已存在则不覆盖）
  inst list                               列出在职员工实例
  bind <employee-id> <paseo-agent-id> [def-id] [credential-file]
  retire <employee-id> <reason>           退役实例并撤销凭证
  config <key> <json-value>               修改 company_meta:config（如 max_running 4）`;

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
      if (sub === 'list') { print(await workforce.defs()); break; }
      if (sub === 'set') {
        const [role, provider, model, thinking, max, priority] = rest;
        if (!defId || !role || !provider || !model) throw new Error(usage);
        await workforce.upsertDef(defId, { role: role as Role, provider, model, thinking: thinking || undefined,
          maxInstances: max ? Number(max) : undefined, priority: priority ? Number(priority) : undefined });
      } else if (sub === 'enable' || sub === 'disable') {
        await database.db.query('UPDATE $def SET enabled = $enabled, error_streak = 0;',
          { def: new RecordId('employee_def', defId!), enabled: sub === 'enable' });
      } else throw new Error(usage);
      print(await workforce.defs());
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
