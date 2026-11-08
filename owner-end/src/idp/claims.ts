/**
 * 机器令牌的角色与固定声明定义。
 *
 * ma_hono 的 client_credentials 客户端只允许固定声明（source_type = "fixed"）。
 * 这里把每种机器角色映射为一组固定声明：ac（访问角色）、ns、db、rl（数据库角色列表，json 数组）。
 * 令牌受众统一为 CLIENT_TOKEN_AUDIENCE。
 */

/** 机器角色。agentClaims 不直接取令牌，只作为员工令牌的固定声明来源。 */
export type MachineRole = 'gateway' | 'viewer' | 'automation' | 'runner' | 'migrator' | 'agentClaims';

/** 各角色的访问角色（ac）与数据库角色列表（rl）。 */
export const MACHINE_ROLE_CLAIMS: Record<MachineRole, { ac: string; rl: string[] }> = {
  gateway: { ac: 'gateway', rl: ['Editor'] },
  viewer: { ac: 'viewer', rl: ['Viewer'] },
  automation: { ac: 'automation', rl: ['Editor'] },
  runner: { ac: 'runner', rl: ['Editor'] },
  migrator: { ac: 'migrator', rl: ['Owner'] },
  agentClaims: { ac: 'agent', rl: ['Editor'] },
};

/** 机器令牌的受众（客户端的 access_token_audience）。 */
export const CLIENT_TOKEN_AUDIENCE = 'company';

/** ma_hono 保留声明名，固定声明不得使用。与 src/domain/clients/access-token-claims-types.ts 一致。 */
export const RESERVED_CLAIM_NAMES: ReadonlySet<string> = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'scope',
  'client_id',
  'nonce',
  'act',
  'task',
]);

/** 管理 API 中的固定声明形状（source_type 恒为 fixed）。 */
export interface FixedClaimSpec {
  claim_name: string;
  source_type: 'fixed';
  fixed_value: string;
  value_type?: 'json';
}

/** 生成某角色的固定声明列表：ac、ns、db 为字符串，rl 为 json 数组字符串。 */
export function fixedClaimsFor(role: MachineRole, scope: { ns: string; db: string }): FixedClaimSpec[] {
  if (scope.ns.trim().length === 0 || scope.db.trim().length === 0) {
    throw new Error('ns 与 db 不能为空');
  }
  const { ac, rl } = MACHINE_ROLE_CLAIMS[role];
  return [
    { claim_name: 'ac', source_type: 'fixed', fixed_value: ac },
    { claim_name: 'ns', source_type: 'fixed', fixed_value: scope.ns },
    { claim_name: 'db', source_type: 'fixed', fixed_value: scope.db },
    { claim_name: 'rl', source_type: 'fixed', fixed_value: JSON.stringify(rl), value_type: 'json' },
  ];
}

/** 机器客户端的注册请求体（POST /admin/tenants/:tenantId/clients）。 */
export interface MachineClientSpec {
  client_name: string;
  client_profile: 'web';
  application_type: 'web';
  token_endpoint_auth_method: 'client_secret_basic';
  grant_types: ['client_credentials'];
  redirect_uris: [];
  response_types: [];
  machine_token_ttl_seconds: number;
  access_token_custom_claims: FixedClaimSpec[];
  /** ma_hono 字段名为 access_token_audience（见 admin-registration-schema.ts）。 */
  access_token_audience: string;
  agent_token_exchange_enabled?: boolean;
  agent_claim_source_client_id?: string;
}

/** ma_hono 对机器令牌 TTL 的上下限（秒）。 */
const MACHINE_TOKEN_MIN_TTL_SECONDS = 60;
const MACHINE_TOKEN_MAX_TTL_SECONDS = 15 * 60;
/** 默认 TTL：10 分钟，留足缓存余量且不超过上限。 */
const DEFAULT_MACHINE_TOKEN_TTL_SECONDS = 10 * 60;

/** 生成机器客户端注册请求体。 */
export function machineClientSpec(
  role: MachineRole,
  input: {
    clientName: string;
    ns: string;
    db: string;
    ttlSeconds?: number;
    agentClaimSourceClientId?: string;
    allowAgentExchange?: boolean;
  },
): MachineClientSpec {
  const clientName = input.clientName.trim();
  if (clientName.length === 0) {
    throw new Error('client_name 不能为空');
  }
  const ttl = input.ttlSeconds ?? DEFAULT_MACHINE_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < MACHINE_TOKEN_MIN_TTL_SECONDS || ttl > MACHINE_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(`机器令牌 TTL 必须是 ${MACHINE_TOKEN_MIN_TTL_SECONDS}-${MACHINE_TOKEN_MAX_TTL_SECONDS} 秒之间的整数`);
  }

  const spec: MachineClientSpec = {
    client_name: clientName,
    client_profile: 'web',
    application_type: 'web',
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['client_credentials'],
    redirect_uris: [],
    response_types: [],
    machine_token_ttl_seconds: ttl,
    access_token_custom_claims: fixedClaimsFor(role, { ns: input.ns, db: input.db }),
    access_token_audience: CLIENT_TOKEN_AUDIENCE,
  };
  if (input.allowAgentExchange === true) {
    spec.agent_token_exchange_enabled = true;
  }
  if (input.agentClaimSourceClientId !== undefined) {
    spec.agent_claim_source_client_id = input.agentClaimSourceClientId;
  }
  return spec;
}
