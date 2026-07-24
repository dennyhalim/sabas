export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const q = url.searchParams.get('q') || '';
  const scope = url.searchParams.get('scope') || 'unrestricted'; // host, domain, unrestricted
  const BRAVE_KEY = env.BRAVE_API_KEY;

  if (!q) {
    return json({error: "Missing ?q= parameter", results: []}, 400);
  }

  // Build query based on scope
  let braveQuery = q;
  if (scope === 'host') braveQuery = `site:${url.hostname} ${q}`;
  if (scope === 'domain') {
    const parts = url.hostname.split('.');
    const domain = parts.length > 1 ? parts.slice(-2).join('.') : url.hostname;
    braveQuery = `site:${domain} ${q}`;
  }

  const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(braveQuery)}&count=20`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_KEY
      }
    });

    if (!res.ok) throw new Error(`Brave API error: ${res.status}`);
    const data = await res.json();

    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age
    }));

    return json({
      query: braveQuery,
      scope: scope,
      total: data.web?.total || 0,
      results: results
    });

  } catch (e) {
    return json({error: e.message, results:[]}, 500)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // so you can call it from anywhere
      'Cache-Control': 'public, max-age=300'
    }
  });
}
