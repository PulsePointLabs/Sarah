import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 8) {
  let delay = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.message?.includes('Rate limit') || String(err).includes('429');
      if (attempt === maxRetries || !is429) throw err;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 30000);
    }
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { session_id } = await req.json();
    if (!session_id) {
      return Response.json({ error: 'Missing session_id' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities.EMGTimeline;
    let totalDeleted = 0;
    let pass = 0;

    // Keep deleting 100 rows at a time until none left
    while (true) {
      pass++;
      const existing = await withRetry(() => db.filter({ session: session_id }, 'time_s', 100));
      if (existing.length === 0) break;
      
      // Delete in small sequential batches with delay (ignore not-found errors)
      for (let i = 0; i < existing.length; i += 20) {
        await Promise.all(existing.slice(i, i + 20).map(async (r) => {
          try {
            await withRetry(() => db.delete(r.id));
          } catch (err) {
            if (!String(err).includes('not found')) throw err;
          }
        }));
        await sleep(300);
      }
      
      totalDeleted += existing.length;
      await sleep(1000);
      
      // Safety limit
      if (pass > 500) {
        return Response.json({ 
          error: 'Cleanup timeout: too many passes', 
          deleted: totalDeleted,
          passes: pass
        }, { status: 500 });
      }
    }

    return Response.json({ ok: true, deleted: totalDeleted, passes: pass });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});