import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function connectCompanyClient(input: { url: URL; credential: string; clientName: string }) {
  if (input.url.hostname !== '127.0.0.1') throw new Error('MCP client requires 127.0.0.1');
  if (!input.credential) throw new Error('employee credential is required');
  const client = new Client({ name: input.clientName, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(input.url, {
    authProvider: { token: async () => input.credential },
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
