/** 执行端状态（服务端 runner.status 的返回值）。 */
export interface RunnerStatus {
  mode: 'token' | 'root';
  connected: boolean;
  tokenExpiresAt?: string;
  lastHeartbeatAt?: string;
  runningJobs: number;
  onDutyEmployees: number;
  ownerEndUrl?: string;
}
