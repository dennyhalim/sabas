export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const q = url.searchParams.get('q') || '';
  const scope = url.searchParams.get('scope') || 'unrestricted';
  const engine = (url.searchParams.get('engine') || 'auto').toLowerCase(); // new
  const SERPER_KEY = env.SERPER_KEY || null;
  const BRAVE_KEY = env.BRAVE_API_KEY || null;

  if (!q) return htmlPage("", "Enter a search query", engine);

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
  let errors = [];

  const engines = {
    serper: () => searchSerper(finalQuery, SERPER_KEY),
    brave: () => searchBrave(finalQuery, BRAVE_KEY),
    jina: () => searchJina(finalQuery),
    ddg: () => searchDDG(finalQuery),
  };

  // If specific engine requested
  if (engine!== 'auto' && engines[engine]) {
    try {
      results = await engines[engine]();
      provider = engine.toUpperCase();
    } catch(e){ errors.push(`${engine}: ` + e.message) }
  }
  // Auto fallback chain
  else {
    const chain = ['serper', 'brave', 'jina', 'ddg'];
    for(const e of chain){
      if(e === 'serper' &&!SERPER_KEY) continue;
      if(e === 'brave' &&!BRAVE_KEY) continue;
      try {
        results = await engines[e]();
        if(results.length > 0) { provider = e.toUpperCase(); break; }
      } catch(err){ errors.push(`${e}: ` + err.message) }
    }
  }

  return htmlPage(q, results, provider, scope, engine, errors.join(' | '));
}

// === PROVIDER FUNCTIONS === Same as before ===

async function searchSerper(q, key) {
  if(!key) throw new Error("No API Key");
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
  if(!key) throw new Error("No API Key");
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20`, {
    headers: {'X-Subscription-Token': key, 'Accept':'application/json'}
  });
  if(!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.web?.results || []).map(r => ({
    title: r.title, url: r.url, snippet: r.description, source: "Brave"
  }));
}

async function searchJina(q) {
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(`https://r.jina.ai/${bingUrl}`);
  if(!res.ok) throw new Error(res.status);
  const md = await res.text();
  const results = [];
  const regex = /\[(.*?)\]\((.*?)\)\s*\n(.*?)(?=\n\[|$)/gs;
  let match;
  while ((match = regex.exec(md))!== null && results.length < 20) {
    results.push({
      title: match[1],
      url: match[2],
      snippet: match[3].replace(/\n/g,' ').slice(0,300),
      source: "Bing via Jina"
    });
  }
  return results;
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

// === HTML RENDER with Engine Selector ===

function htmlPage(query, results = [], provider = "", scope = "unrestricted", engine = "auto", error = null) {
  const engines = ['auto','serper','brave','jina','ddg'];
  const engineOptions = engines.map(e =>
    `<option value="${e}" ${engine===e?'selected':''}>${e.toUpperCase()} ${e==='auto'?'(Fallback)':''}</option>`
  ).join('');

  const resultHTML = results.map(r => `
    <article>
      <h3><a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></h3>
      <small><a href="${r.url}" target="_blank">${r.url}</a> • <kbd>${r.source}</kbd></small>
      <p>${escapeHtml(r.snippet)}</p>
    </article>
  `).join('');

  const providerBadge = provider? `<mark>Results from: ${provider}</mark>` : '';
  const errorBadge = error? `<details><summary>Error Log</summary><code>${escapeHtml(error)}</code></details>` : '';

  return new Response(`
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search: ${escapeHtml(query)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <style>main {max-width: 850px} article {margin-bottom: 2rem} kbd{font-size:.7rem}</style>
</head>
<body>
  <main class="container">
    <h1>🔍 Lite Search</h1>

    <form method="GET" role="search">
      <input type="search" name="q" placeholder="Search the web..." value="${escapeHtml(query)}" required>
      <div class="grid">
        <select name="engine">
          ${engineOptions}
        </select>
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
      ${results.length > 0? resultHTML : (query? '<p><i>No results found.</i></p>' : '<p>Pick an engine above.</p>')}
    </section>

    <footer>
      <small>Engine: auto=Serper>Brave>Jina>DDG. Keys: SERPER_KEY, BRAVE_API_KEY</small>
    </footer>
  </main>
</body>
</html>
  `, {
    headers: {'Content-Type': 'text/html; charset=utf-8'}
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
