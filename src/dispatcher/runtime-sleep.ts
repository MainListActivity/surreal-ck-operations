import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

/** Paseo 0.14 kill_agent calls closeAgentCommand, retaining persistence (unlike delete/archive). */
export async function closePaseoRuntime(agentId: string, endpoint = process.env.SCK_PASEO_RUNTIME_MCP_URL ?? 'http://127.0.0.1:6767/mcp/agents'): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('runtime sleep requires a local owner MCP endpoint');
  }
  const client = new Client({name:'sck-memory-lru',version:'1.0.0'});
  const transport = new StreamableHTTPClientTransport(url);
  try {
    await client.connect(transport);
    const result = await client.callTool({name:'kill_agent',arguments:{agentId}});
    if (result.isError || (result.structuredContent as {success?:boolean}|undefined)?.success !== true) {
      throw new Error('Paseo did not confirm runtime closure');
    }
  } finally {
    await client.close();
  }
}
