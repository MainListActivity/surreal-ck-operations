import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { Credential, EmployeeId, EnrollmentAdmin, Principal, Role } from './contracts.ts';
import { CompanyError, ROLES } from './core.ts';

/** Local root-only enrollment API. Never pass this object to the MCP adapter. */
export class LocalEnrollmentAdmin implements EnrollmentAdmin {
  constructor(private readonly database: CompanyDatabase) {}

  async enroll(employeeId: EmployeeId, role: Role, capabilities: Principal['capabilities']): Promise<Credential> {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(employeeId)) throw new CompanyError('invalid', 'Invalid employee ID');
    if (!ROLES.includes(role)) throw new CompanyError('invalid', 'Invalid role');
    if (capabilities.some(value => !['execute', 'review', 'manage'].includes(value))) {
      throw new CompanyError('invalid', 'Invalid capability');
    }
    const employee = new RecordId('employee', employeeId);
    if (await this.database.db.select(employee)) throw new CompanyError('conflict', 'Employee already enrolled');
    const token = `sck_${randomBytes(32).toString('base64url')}`;
    await this.database.db.query('CREATE $employee CONTENT $row;', {
      employee,
      row: {
        role, capabilities: [...capabilities],
        credential_digest: createHash('sha256').update(token).digest('hex'),
        credential_hash: await Bun.password.hash(token, { algorithm: 'argon2id' }),
        revoked: false, active_task: null,
      },
    });
    return token;
  }

  /** Default is an explicit security revocation: security_revoked is never cleared, so it also covers a
   * reviewer that was retired normally before. Scheduler retirement passes 'retirement' and only swaps the credential. */
  async revoke(employeeId: EmployeeId, cause: 'security' | 'retirement' = 'security'): Promise<void> {
    await this.database.db.query(cause === 'security'
      ? 'UPDATE $employee SET revoked = true, security_revoked = true, credential_digest = $digest;'
      : 'UPDATE $employee SET revoked = true, credential_digest = $digest;', {
      employee: new RecordId('employee', employeeId), digest: `revoked-${randomUUID()}`,
    });
  }
}
