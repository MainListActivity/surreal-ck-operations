// Counts the bytes an MCP client receives for each tools/call (SYS01, F5). The count is the whole HTTP body of the
// call: the JSON-RPC frame, the tool result (text note and structuredContent) and the answer inside it. A budget
// measured on the answer alone missed the text copy that doubled the body, so the tests measure the body.

export type WireCount = { bodies: number[] };

export function countingFetch(): WireCount & { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> } {
  const bodies: number[] = [];
  const fetchCounted = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, init);
    const sent = typeof init?.body === 'string' ? init.body : '';
    if (!response.body || !sent.includes('"tools/call"')) return response;
    // The count of the latest call grows with each chunk the client reads; it is final when the call resolves.
    const index = bodies.push(0) - 1;
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bodies[index]! += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }));
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { bodies, fetch: fetchCounted };
}

/** The whole body of the latest tools/call a client counted. Throws when none was counted, so a missing count never passes. */
export function lastBody(wire: WireCount): number {
  const last = wire.bodies.at(-1);
  if (last === undefined) throw new Error('no tools/call response was counted');
  return last;
}
