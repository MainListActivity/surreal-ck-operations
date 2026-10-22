/**
 * B1: a QA restricted session must never reach the owner RPC paths. The Paseo PluginHandlerContext only exposes
 * `paseo`; a host that carries a restricted principal/token passes it in the same context object. Every owner
 * handler is wrapped with this predicate. The QA entry is the separate /q/ read-only console, which has no owner RPC.
 */
export const isQaContext = (context: unknown): boolean => {
  const c = context as { principal?: { role?: string }; qaSession?: boolean; qa?: boolean; qaToken?: string } | undefined;
  return c?.principal?.role === 'qa' || c?.qaSession === true || c?.qa === true || typeof c?.qaToken === 'string';
};
