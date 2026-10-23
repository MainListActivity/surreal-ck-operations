// Gateway middleware: options are published by the company service, never fetched on a request.
// Selecting an ordered fallback group avoids guessing a model from magpie's account-only seats.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function onRequest(body, ctx) {
  const policy = ctx.options?.routes?.[body.model];
  if (!policy?.length) return;
  const seed = body.metadata?.user_id || body.prompt_cache_key;
  // Stable per lease. Ten percent explore, including candidates with no task history.
  const n = seed ? hash(String(seed)) : 0;
  const i =
    seed && n % 100 < 10 && policy.length > 1
      ? 1 + (Math.floor(n / 100) % (policy.length - 1))
      : 0;
  return { ...body, model: policy[i].group };
}
