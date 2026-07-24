export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';

    // HTML UI
    if (!query) {
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head><title>MiniSearch</title>
        <style>
          body{font-family:system-ui;max-width:800px;margin:40px auto;padding:20px}
          input{width:70%;padding:10px;font-size:16px}
          button{padding:10px 20px}
         .result{margin:20px 0}
         .result a{font-size:18px;color:#1a0dab;text-decoration:none}
         .url{color:#006621;font-size:13px}
         .desc{color:#545454}
         .engine{font-size:12px;color:#888}
        </style>
        </head>
        <body>
          <h1>MiniSearch</h1>
          <form>
            <input name="q" placeholder="Search 4 engines..." value="">
            <button>Search</button>
          </form>
        </body>
        </html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }

    // 1. Query all engines in parallel
    const engines = [
      fetchDDG(query),
      fetchBing(query),
      fetchBrave(query),
      fetchWiki(query)
    ];

    const results = await Promise.allSettled(engines);
    let allResults = results.flatMap(r => r.status === 'fulfilled'? r.value : []);

    // 2. Deduplicate by URL
    const seen = new Set();
    allResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    // 3. Render results
    const html = `
      <!DOCTYPE html>
      <html><head><title>${query} - MiniSearch</title>
      <style>
        body{font-family:system-ui;max-width:800px;margin:40px auto;padding:20px}
        input{width:70%;padding:10px;font-size:16px}
       .result{margin:20px 0}
       .result a{font-size:18px;color:#1a0dab;text-decoration:none}
       .url{color:#006621;font-size:13px;word-break:break-all}
       .desc{color:#545454;line-height:1.5}
       .engine{font-size:12px;color:#888;background:#f1f3f4;padding:2px 6px;border-radius:4px}
      </style>
      </head><body>
        <h1>MiniSearch</h1>
        <form>
          <input name="q" value="${escapeHtml(query)}" placeholder="Search 4 engines...">
          <button>Search</button>
        </form>
        <p>About ${allResults.length} results</p>
        ${allResults.map(r => `
          <div class="result">
            <a href="${r.url}" target="_blank">${escapeHtml(r.title)}</a>
            <div class="url">${escapeHtml(r.url)}</div>
            <div class="desc">${escapeHtml(r.snippet)}</div>
            <span class="engine">${r.engine}</span>
          </div>
        `).join('')}
      </body></html>
    `;

    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  }
}

// Helper to escape HTML
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// 4 ENGINE SCRAPERS
async function fetchDDG(query) {
  const res = await fetch(`https://duckgo.com/html/?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const results = [];
  const regex = /<a class="result__a" href="(.*?)">(.*?)<\/a>.*?<a class="result__snippet">(.*?)<\/a>/gs;
  let match;
  while ((match = regex.exec(html)) && results.length < 10) {
    results.push({ title: stripTags(match[2]), url: match[1], snippet: stripTags(match[3]), engine: 'DDG' });
  }
  return results;
}

async function fetchBing(query) {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const results = [];
  const regex = /<h2><a href="(.*?)" h="ID=.*?" target="_blank">(.*?)<\/a><\/h2>.*?<p>(.*?)<\/p>/gs;
  let match;
  while ((match = regex.exec(html)) && results.length < 10) {
    results.push({ title: stripTags(match[2]), url: match[1], snippet: stripTags(match[3]), engine: 'Bing' });
  }
  return results;
}

async function fetchBrave(query) {
  const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const results = [];
  const regex = /<a href="(.*?)" class=".*?" target="_blank".*?<h3.*?>(.*?)<\/h3>.*?<p.*?>(.*?)<\/p>/gs;
  let match;
  while ((match = regex.exec(html)) && results.length < 10) {
    results.push({ title: stripTags(match[2]), url: match[1], snippet: stripTags(match[3]), engine: 'Brave' });
  }
  return results;
}

async function fetchWiki(query) {
  const res = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json`);
  const json = await res.json();
  const titles = json[1], urls = json[3], descs = json[2];
  return titles.map((t, i) => ({ title: t, url: urls[i], snippet: descs[i] || 'Wikipedia', engine: 'Wikipedia' }));
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}
