// 云端公司库迁移：bun scripts/company-migrate.ts（不带参数）
//
// 只从环境变量读配置（loadDatabaseConfig），只用于云端：必须设置 COMPANY_DB_URL。
// 以 migrator 令牌登录（不用 root 账号），流程：连接 → 选定 ns/db → 核对库归属（claimDatabase）→ 按序应用 schema 001 至 057。
// 不做 namespace / database 的 DEFINE，也不跑本机 bootstrap。失败时输出“结果: 失败”并非零退出。
// 输出不含令牌、client secret 或带凭证的 URL。
import { loadDatabaseConfig, type DatabaseConfig } from '../src/config.ts';
import { CompanyDatabase } from '../src/database.ts';

export type MigrateLog = (line: string) => void;

export const CLOUD_ONLY_MESSAGE = 'company-migrate 只用于云端，需设置 COMPANY_DB_URL';

/** 把错误整理成一行可读原因：去掉 URL 与 Bearer 令牌，限制长度，避免把凭证带进输出。 */
export function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, '<地址已隐藏>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <已隐藏>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 300) || '未知错误';
}

/**
 * 在已连接并选定 ns/db 的 migrator 连接上，核对库归属并应用全部 schema。
 * 调用方负责 connect、useDatabase 与 close。被 company-migrate 与 cloud-bootstrap 共用。
 */
export async function migrateCompanySchema(db: CompanyDatabase, log: MigrateLog): Promise<{ fresh: boolean }> {
  log('阶段 2/3：核对库归属（claimDatabase）');
  const fresh = await db.claimDatabase();
  log(fresh ? '  空库：按新装处理' : '  已有公司库：按序补齐 schema');
  log('阶段 3/3：应用 schema 001 至 057');
  await db.applySchema(fresh);
  return { fresh };
}

export interface RunCompanyMigrateOptions {
  log?: MigrateLog;
  /** 测试注入点：默认用 migrator 角色创建 CompanyDatabase。 */
  createDatabase?: (config: DatabaseConfig) => CompanyDatabase;
}

/** 云端迁移的完整流程；失败抛错，由调用方决定输出与退出码。 */
export async function runCompanyMigrate(
  config: DatabaseConfig,
  options: RunCompanyMigrateOptions = {},
): Promise<{ fresh: boolean }> {
  if (!config.cloud) throw new Error(CLOUD_ONLY_MESSAGE);
  const log = options.log ?? (() => {});
  const db = options.createDatabase?.(config) ?? new CompanyDatabase(config, { role: 'migrator' });
  try {
    log('阶段 1/3：连接公司库（migrator 令牌登录）');
    await db.connect();
    await db.useDatabase();
    return await migrateCompanySchema(db, log);
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
      await runCompanyMigrate(config, { log: line => console.log(line) });
      console.log('结果: 成功');
    } catch (error) {
      console.log(`结果: 失败 原因=${reasonOf(error)}`);
      process.exitCode = 1;
    }
  }
}
