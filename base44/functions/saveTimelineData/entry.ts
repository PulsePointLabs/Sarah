import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 8, baseDelay = 2000) {
  let delay = baseDelay;
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

// Downsample HR rows (not EMG — EMG is now sent in chunks at full resolution)
function downsampleRows(rows, targetMax) {
  if (rows.length <= targetMax) return rows;
  const n = Math.ceil(rows.length / targetMax);
  const result = [];
  for (let i = 0; i < rows.length; i += n) {
    result.push(rows[i]);
  }
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { session_id, entity, rows, action } = await req.json();
    if (!session_id || !entity) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!['HeartRateTimeline', 'EMGTimeline'].includes(entity)) {
      return Response.json({ error: 'Invalid entity' }, { status: 400 });
    }

    const filterKey = entity === 'EMGTimeline' ? 'time_s' : 'time_offset_s';
    const db = base44.asServiceRole.entities[entity];

    // action=fetch: read all rows for this session (handles large datasets via pagination)
    if (action === 'fetch') {
      let allRows = [];
      let skip = 0;
      const PAGE = 10000;
      while (true) {
        const page = await withRetry(() => db.filter({ session: session_id }, filterKey, PAGE, skip));
        allRows = allRows.concat(page);
        if (page.length < PAGE) break;
        skip += PAGE;
      }
      return Response.json({ ok: true, rows: allRows, count: allRows.length });
    }

    // action=clear: delete one page of rows (call repeatedly from frontend until done=true)
    // Each call deletes up to 200 rows to stay well within timeout limits
    if (action === 'clear') {
      const existing = await withRetry(() => db.filter({ session: session_id }, filterKey, 200));
      if (existing.length === 0) {
        return Response.json({ ok: true, action: 'clear', deleted: 0, done: true });
      }
      // Delete all fetched rows in parallel batches of 50
      for (let i = 0; i < existing.length; i += 50) {
        await Promise.all(existing.slice(i, i + 50).map((r) => withRetry(() => db.delete(r.id))));
      }
      return Response.json({ ok: true, action: 'clear', deleted: existing.length, done: existing.length < 200 });
    }

    // action=append (or default): insert rows WITHOUT deleting first
    // Caller is responsible for clearing first via action=clear
    if (!rows || rows.length === 0) {
      return Response.json({ ok: true, inserted: 0 });
    }

    // For HR timeline only: downsample if very large
    let finalRows = rows;
    if (entity === 'HeartRateTimeline' && rows.length > 10000) {
      finalRows = downsampleRows(rows, 10000);
    }

    const tagged = finalRows.map((r) => ({ ...r, session: session_id }));
    // Use smaller chunks with longer delays to avoid rate limits on large datasets
    const CHUNK = entity === 'EMGTimeline' ? 1000 : 300;
    const DELAY = entity === 'EMGTimeline' ? 1000 : 800;
    for (let i = 0; i < tagged.length; i += CHUNK) {
      await withRetry(() => db.bulkCreate(tagged.slice(i, i + CHUNK)));
      if (i + CHUNK < tagged.length) await sleep(DELAY);
    }

    return Response.json({ ok: true, inserted: tagged.length, original: rows.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});