import { verifyAdmin, unauthorized, json } from '../_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (!await verifyAdmin(request, env)) return unauthorized();

  const method = request.method;

  if (method === 'GET') {
    const { results } = await env.BOOKS_DB.prepare(
      'SELECT * FROM csv_sources ORDER BY created_at DESC'
    ).all();
    return json({ sources: results });
  }

  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { name, url } = body;
    if (!url) return json({ error: 'url required' }, 400);
    await env.BOOKS_DB.prepare(
      'INSERT OR IGNORE INTO csv_sources (name, url) VALUES (?, ?)'
    ).bind(name?.trim() || url, url.trim()).run();
    return json({ ok: true });
  }

  if (method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!body.url) return json({ error: 'url required' }, 400);
    await env.BOOKS_DB.prepare(
      'DELETE FROM csv_sources WHERE url = ?'
    ).bind(body.url).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
