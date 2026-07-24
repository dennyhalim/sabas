export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const q = url.searchParams.get('q') || '';
  const scope = url.searchParams.get('scope') || 'unrestricted'; // host, domain, unrestricted
  const SERPER_KEY = env.SERPER_KEY || null;
  const BRAVE_KEY = env.BRAVE_API_KEY || null;

  if (!q) return htmlPage("", "Enter a search query");

  // Build query based on scope
  let finalQuery = q;
  if (scope === 'host') finalQuery = `site:${url.hostname} ${q}`;
  if (scope === 'domain') {
    const parts = url.hostname.split('.');
    const domain = parts.length > 1? parts.slice(-2).join('.') : url.hostname;
    finalQuery = `site:${domain} ${q}`;
  }

  let results = [];
  let provider = "None";
  let error = null;

  
  // 1. Try Serper
  if (SERPER_KEY) {
    try {
      results = await searchSerper(finalQuery, SERPER_KEY);
      provider = "Serper - Google";
    } catch(e){ error = "Serper: " + e.message }
  }

  // 2. Fallback to Brave
  if (results.length === 0 && BRAVE_KEY) {
    try {
      results = await searchBrave(finalQuery, BRAVE_KEY);
      provider = "Brave Search";
    } catch(e){ error = "Brave: " + e.message }
  }

  // 3. Fallback to DDG
  if (results.length === 0) {
    try {
      results = await searchDDG(finalQuery);
      provider = "DuckGo Instant";
    } catch(e){ error = "DDG: " + e.message }
  }

  return htmlPage(q, results, provider, scope, error);
}

// === PROVIDER FUNCTIONS ===

async function searchSerper(q, key) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {'X-API-KEY': key, 'Content-Type':'application/json'},
    body: JSON.stringify({q, num: 20})
  });
  if(!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.organic || []).map(r => ({
    title: r.title, url: r.link, snippet: r.snippet, source: "Google"
  }));
}

async function searchBrave(q, key) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20`, {
    headers: {'X-Subscription-Token': key, 'Accept':'application/json'}
  });
  if(!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.web?.results || []).map(r => ({
    title: r.title, url: r.url, snippet: r.description, source: "Brave"
  }));
}

async function searchDDG(q) {
  const res = await fetch(`https://api.duckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`);
  if(!res.ok) throw new Error(res.status);
  const data = await res.json();
  const results = [];
  if(data.AbstractText) results.push({title: data.Heading, url: data.AbstractURL, snippet: data.AbstractText, source: "DDG"});
  (data.RelatedTopics || []).slice(0,15).forEach(t => {
    if(t.FirstURL) results.push({title: t.Text.split(' - ')[0], url: t.FirstURL, snippet: t.Text, source: "DDG"});
  });
  return results;
}

// === HTML RENDER ===

function htmlPage(query, results = [], provider = "", scope = "unrestricted", error = null) {
  const resultHTML = results.map(r => `
    <article>
      <h3><a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></h3>
      <small><a href="${r.url}" target="_blank">${r.url}</a> • ${r.source}</small>
      <p>${escapeHtml(r.snippet)}</p>
    </article>
  `).join('');

  const providerBadge = provider? `<mark>Results from: ${provider}</mark>` : '';
  const errorBadge = error? `<blockquote style="color:crimson">Fallback used. ${escapeHtml(error)}</blockquote>` : '';

  return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search: ${escapeHtml(query)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <style>main {max-width: 800px} article {margin-bottom: 1.5rem}</style>
</head>
<body>
  <main class="container">
    <h1>🔍 Lite Search</h1>

    <form method="GET">
      <div class="grid">
        <input type="search" name="q" placeholder="Search..." value="${escapeHtml(query)}" required>
        <select name="scope">
          <option value="unrestricted" ${scope==='unrestricted'?'selected':''}>Web</option>
          <option value="domain" ${scope==='domain'?'selected':''}>This Domain</option>
          <option value="host" ${scope==='host'?'selected':''}>This Host</option>
        </select>
      </div>
      <button type="submit">Search</button>
    </form>

    ${providerBadge}
    ${errorBadge}

    <section>
      ${results.length > 0? resultHTML : (query? '<p>No results found.</p>' : '<p>Try searching above.</p>')}
    </section>

    <footer>
      <small>Auto-fallback: Serper > Brave > DDG. Set SERPER_KEY and BRAVE_API_KEY in Pages Settings.</small>
    </footer>
  </main>
</body>
</html>
  `, {
    headers: {'Content-Type': 'text/html; charset=utf-8'}
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
