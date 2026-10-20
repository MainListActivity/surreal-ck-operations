import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RecordId } from 'surrealdb';
import type { CompanyDatabase } from './database.ts';
import type { Credential, EmployeeId, EnrollmentAdmin, Principal, Role } from './contracts.ts';
import { CompanyError, ROLES } from './core.ts';
import { gateCredentialChange } from './retirement.ts';

/** The digest a revocation writes in place of the credential digest: it matches no token, so the old credential dies. */
export const revokedCredentialDigest = (): string => `revoked-${randomUUID()}`;

/** Local root-only enrollment API. Never pass this object to the MCP adapter. */
export class LocalEnrollmentAdmin implements EnrollmentAdmin {
  /** `afterDecision` is a test seam (see gateCredentialChange); production passes nothing. */
  constructor(private readonly database: CompanyDatabase, private readonly afterDecision?: (employeeId: EmployeeId) => Promise<void>) {}

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

  /**
   * The explicit security revocation (admin revoke). It passes the same retirement gate as a retirement: refused while the employee
   * holds a lease or is bound to unfinished work, before any write. An accepted revocation keeps security_revoked, and it never
   * sets the retirement mark, so it cannot read as an ordinary retirement. security_revoked is never cleared, so it also covers a
   * reviewer that was retired normally before.
   */
  async revoke(employeeId: EmployeeId): Promise<void> {
    await gateCredentialChange(this.database.db, employeeId, {
      operation: 'revoke',
      statement: 'UPDATE $employee SET revoked = true, security_revoked = true, credential_digest = $digest;',
      vars: { digest: revokedCredentialDigest() },
    }, this.afterDecision);
  }
}
