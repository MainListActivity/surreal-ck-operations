// 云端空库开通：bun scripts/cloud-bootstrap.ts（不带参数）
//
// 面向空的 company/main：先按 company-migrate 的同一流程应用全部 schema，再写入初始编制（employee_def）。
// 只通过 migrator 连接写入（rl=Owner，因此 employee_def 的 PERMISSIONS NONE 不挡它）。
// 必须可重复执行：每个编制按固定 id 检查是否存在，已存在的整行不动（老板改过的值保留），只补缺的行。
// 失败不留半成品的做法：不包整体事务（schema 本身就是多条语句、非原子）。每一步都幂等：
// 中途失败后再次运行，迁移照常补齐，缺失的编制逐条补上，已写入的不会重复。
import { join } from 'node:path';
import { loadDatabaseConfig, serviceHome, type DatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';
import { SEED_DEFS } from '../src/seed.ts';
import { Workforce } from '../src/workforce.ts';
import { CLOUD_ONLY_MESSAGE, migrateCompanySchema, reasonOf, type MigrateLog } from './company-migrate.ts';

/**
 * 写入初始编制：只补 SEED_DEFS 中库里不存在的 employee_def，不覆盖已存在的行。
 * 返回本次新写入的编制 id。
 */
export async function seedInitialData(db: CompanyDatabase, log: MigrateLog): Promise<string[]> {
  // credentialDir 只在绑定员工时使用，初始编制写入不涉及；这里传服务目录下的 credentials 占位即可。
  const workforce = new Workforce(db, join(serviceHome(), 'credentials'));
  const existing = new Set((await workforce.defs()).map(def => def.id));
  const inserted: string[] = [];
  for (const def of SEED_DEFS) {
    if (existing.has(def.id)) continue;
    await workforce.upsertDef(def.id, def);
    inserted.push(def.id);
  }
  log(`  编制：新增 ${inserted.length} 条，已存在 ${existing.size} 条，共 ${SEED_DEFS.length} 条定义`);
  return inserted;
}

export interface RunCloudBootstrapOptions {
  log?: MigrateLog;
  /** 测试注入点：默认用 migrator 角色创建 CompanyDatabase。 */
  createDatabase?: (config: DatabaseConfig) => CompanyDatabase;
}

/** 云端空库开通的完整流程：迁移，然后补初始编制；失败抛错。 */
export async function runCloudBootstrap(
  config: DatabaseConfig,
  options: RunCloudBootstrapOptions = {},
): Promise<{ fresh: boolean; inserted: string[] }> {
  if (!config.cloud) throw new Error(CLOUD_ONLY_MESSAGE);
  const log = options.log ?? (() => {});
  const db = options.createDatabase?.(config) ?? new CompanyDatabase(config, { role: 'migrator' });
  try {
    log('阶段 1/4：连接公司库（migrator 令牌登录）');
    await db.connect();
    await db.useDatabase();
    const { fresh } = await migrateCompanySchema(db, log);
    log('阶段 4/4：补齐初始编制');
    const inserted = await seedInitialData(db, log);
    return { fresh, inserted };
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  // 先看环境变量：没有 COMPANY_DB_URL 时不去读本机配置文件，直接说明用途。
  if (!process.env.COMPANY_DB_URL) {
    console.log(CLOUD_ONLY_MESSAGE);
    process.exitCode = 1;
  } else {
    try {
      const config = loadDatabaseConfig();
      await runCloudBootstrap(config, { log: line => console.log(line) });
      console.log('结果: 成功');
    } catch (error) {
      console.log(`结果: 失败 原因=${reasonOf(error)}`);
      process.exitCode = 1;
    }
  }
}
