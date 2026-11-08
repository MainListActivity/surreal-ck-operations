/**
 * 在岗员工：与看板（readBoard）和员工列表使用同一个筛选条件。已撤销、已退休或没有定义也没有 Paseo 会话的员工不算在岗。
 */
import type { Surreal } from 'surrealdb';
import { keyOf, type Row } from './rows.ts';

export interface StaffRow {
  employee: string;
  /** 员工定义编号（有则用），否则为职能。 */
  name: string;
  role: string;
}

export async function inServiceEmployees(db: Surreal): Promise<StaffRow[]> {
  const [rows] = await db.query<[Row[]]>(
    `SELECT id, role, def FROM employee WHERE revoked != true AND retired != true AND (def != NONE OR paseo_agent_id != NONE) ORDER BY id;`);
  return (rows ?? []).map((row) => {
    const employee = keyOf(row.id);
    return {
      employee,
      name: row.def ? keyOf(row.def) : String(row.role ?? employee),
      role: String(row.role ?? ''),
    };
  });
}
