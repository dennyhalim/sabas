export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const q = url.searchParams.get('q') || '';
  const scope = url.searchParams.get('scope') || 'unrestricted'; // host, domain, unrestricted
  const num = parseInt(url.searchParams.get('num') || '10'); // 1-20
  const SERPER_KEY = env.SERPER_KEY;

  if (!SERPER_KEY) {
    return json({error: "Missing SERPER_KEY env var"}, 500);
  }
  if (!q) {
    return json({error: "Missing ?q= parameter", results: []}, 400);
  }

  // Build query based on scope
  let serperQuery = q;
  if (scope === 'host') serperQuery = `site:${url.hostname} ${q}`;
  if (scope === 'domain') {
    const parts = url.hostname.split('.');
    const domain = parts.length > 1 ? parts.slice(-2).join('.') : url.hostname;
    serperQuery = `site:${domain} ${q}`;
  }

  const payload = {
    q: serperQuery,
    num: Math.min(num, 20),
    page: 1,
    type: "search", // search, images, news, places
    engine: "google"
  };

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Serper API error: ${res.status} ${await res.text()}`);
    const data = await res.json();

    const results = (data.organic || []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      position: r.position,
      sitelinks: r.sitelinks || []
    }));

    return json({
      query: serperQuery,
      scope: scope,
      total: data.searchParameters?.num || results.length,
      answerBox: data.answerBox || null,
      knowledgeGraph: data.knowledgeGraph || null,
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
      'Access-Control-Allow-Origin': '*', // allow CORS
      'Cache-Control': 'public, max-age=600' // cache 10min
    }
  });
}
