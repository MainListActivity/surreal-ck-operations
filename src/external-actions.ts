/** GitHub 仓库 slug 解析；gh 调用的唯一保留出口。
 * and the "https://github.com/owner/name" forms) or from a value that already is a slug. Anything else — a filesystem path,
 * a bare repo name — has no slug to compare, and the caller must treat the binding as unverified instead of guessing (QA D5).
 */
export function githubRepoSlug(value: string): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  const matched = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  return matched ? `${matched[1]}/${matched[2]}` : undefined;
}
