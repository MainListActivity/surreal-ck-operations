/** The stored state stays exhausted until a successful probe. Views show the next allowed action. */
export function providerHealthView(rows: readonly {
  id?: { id: unknown }; provider?: string; state: string; until?: number; last_error?: string;
}[], nowSeconds: number): Array<{ provider: string; state: string; until?: number; lastError?: string }> {
  return rows.map(row => ({
    provider: row.id ? String(row.id.id) : row.provider ?? 'unknown',
    state: row.state === 'exhausted' && nowSeconds >= (row.until ?? 0) ? 'probe' : row.state,
    ...(row.until !== undefined ? { until: row.until } : {}),
    ...(row.last_error !== undefined ? { lastError: row.last_error } : {}),
  }));
}
