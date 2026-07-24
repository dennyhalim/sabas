export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  const q = url.searchParams.get('q') || '';
  const scope = url.searchParams.get('scope') || 'unrestricted'; // host, domain, unrestricted

  if (!q) {
    return json({error: "Missing?q= parameter", results: []}, 400);
  }

  // Build query based on scope
  let ddgQuery = q;
  if (scope === 'host') ddgQuery = `site:${url.hostname} ${q}`;
  if (scope === 'domain') {
    const parts = url.hostname.split('.');
    const domain = parts.length > 1? parts.slice(-2).join('.') : url.hostname;
    ddgQuery = `site:${domain} ${q}`;
  }

  const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(ddgQuery)}&format=json&no_html=1&skip_disambig=1`;

  try {
    const res = await fetch(apiUrl, {
      headers: {'User-Agent': 'Mozilla/5.0 Cloudflare-Worker'}
    });

    if (!res.ok) throw new Error(`DDG API error: ${res.status}`);
    const data = await res.json();

    const results = [];

    // 1. Answer box - definition, calc, etc
    if (data.Answer) {
      results.push({
        type: "answer",
        title: data.Heading || "Instant Answer",
        url: data.AbstractURL,
        snippet: data.Answer
      });
    }

    // 2. Abstract
    if (data.AbstractText) {
      results.push({
        type: "abstract",
        title: data.Heading,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        image: data.Image
      });
    }

    // 3. Related Topics - this is the main "web results"
    function extractTopics(topics) {
      for (const t of topics) {
        if (t.Topics) extractTopics(t.Topics); // nested
        else if (t.FirstURL && t.Text) {
          results.push({
            type: "related",
            title: t.Text.split(' - ')[0],
            url: t.FirstURL,
            snippet: t.Text
          });
        }
      }
    }
    extractTopics(data.RelatedTopics || []);

    return json({
      query: ddgQuery,
      scope: scope,
      total: results.length,
      definition: data.Definition,
      results: results.slice(0, 20) // limit to 20
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600' // cache 1 hour
    }
  });
}
