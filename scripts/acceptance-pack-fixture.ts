/**
 * SYS02 C3 packed fixture: the default request path a built bundle must still execute under Node.
 * The probe builds this module for Node, imports the bundle with Node and asserts the response.
 */
export default async function defaultRequest(): Promise<{ ok: boolean; path: string }> {
  return { ok: true, path: '/default' };
}
