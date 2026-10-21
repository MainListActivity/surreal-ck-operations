import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export async function connectCompanyClient(input: {
  url: URL; credential: string; clientName: string; gateToken?: string;
  // Test seam: lets a test count the bytes of every HTTP response it receives.
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}) {
  const loopback = loopbackHosts.has(input.url.hostname);
  if (!loopback && input.url.protocol !== 'https:') {
    throw new Error('remote MCP endpoint requires https');
  }
  if (!input.credential) throw new Error('employee credential is required');
  const client = new Client({ name: input.clientName, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(input.url, {
    authProvider: { token: async () => input.credential },
    ...(input.gateToken ? { requestInit: { headers: { 'X-SCK-Token': input.gateToken } } } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  await client.connect(transport);
  return {
    client,
    async close() {
      await transport.terminateSession();
      await client.close();
    },
  };
}
