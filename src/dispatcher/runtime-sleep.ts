import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

/** Paseo 0.14 kill_agent calls closeAgentCommand, retaining persistence (unlike delete/archive). */
export async function closePaseoRuntime(agentId: string, endpoint = process.env.SCK_PASEO_RUNTIME_MCP_URL ?? 'http://127.0.0.1:6767/mcp/agents', beforeClose: () => Promise<boolean> = async()=>true): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('runtime sleep requires a local owner MCP endpoint');
  }
  const client = new Client({name:'sck-memory-lru',version:'1.0.0'});
  // Include initialization, the reservation check and tool invocation in one bounded network budget.
  const deadline=Date.now()+10_000, signal=AbortSignal.timeout(10_000);
  const transport = new StreamableHTTPClientTransport(url,{fetch:async(input,init)=>{
    if(Date.now()>=deadline)throw new Error('runtime close deadline expired');
    return fetch(input,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
  }});
  try {
    await client.connect(transport);
    if (!await beforeClose() || Date.now()>=deadline) throw new Error('runtime sleep reservation moved or expired');
    const result = await client.callTool({name:'kill_agent',arguments:{agentId}});
    if (result.isError || (result.structuredContent as {success?:boolean}|undefined)?.success !== true) {
      throw new Error('Paseo did not confirm runtime closure');
    }
  } finally {
    await client.close();
  }
}
