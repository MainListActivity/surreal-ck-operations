// 凭证文件里的 secret：每次需要时读取，不缓存、不回显。文件权限必须是 600，免得同机其他用户读到机密。
import { readFileSync, statSync, type Stats } from 'node:fs';

/** 读取凭证文件（去掉首尾空白）。文件缺失、不是普通文件、权限不是 600 或内容为空都直接报错；错误信息不含文件内容。 */
export function readSecretFile(path: string): string {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`凭证文件不存在或不可读：${path}`);
  }
  if (!stat.isFile()) throw new Error(`凭证路径不是普通文件：${path}`);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new Error(`凭证文件权限必须是 600：${path}（当前 ${mode.toString(8)}）`);
  const value = readFileSync(path, 'utf8').trim();
  if (value === '') throw new Error(`凭证文件为空：${path}`);
  return value;
}
