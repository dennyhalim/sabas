export async function onRequest(context) {
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'html';
  const opmlUrl = url.searchParams.get('url') || 'https://raw.githubusercontent.com/dennyhalim/alkitabiah/refs/heads/master/alkitabiah.opml';

  try {
    const res = await fetch(opmlUrl, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new Error(`OPML fetch failed: ${res.status}`);
    
    const opmlText = await res.text();
    const items = parseOPML(opmlText);

    if (!items.length) throw new Error('No <outline> found in OPML');

    if (format === 'rss') return rssResponse(items);

    // Fetch posts for each RSS
    const itemsWithPosts = await Promise.all(items.map(async item => {
      if (!item.rss) return {...item, posts: [], error: 'No xmlUrl in OPML' };
      
      try {
        const r = await fetch(item.rss, {
          cf: { cacheTtl: 600 },
          headers: { 'User-Agent': 'Mozilla/5.0 Cloudflare-OPML' }
        });
        if (!r.ok) throw new Error(`RSS ${r.status}`);
        
        const posts = parseRSS(await r.text());
        return {...item, posts, error: null };
      } catch (e) {
        return {...item, posts: [], error: e.message };
      }
    }));

    return htmlWithPosts(itemsWithPosts, format === 'embed');

  } catch (e) {
    return new Response(`Error: ${e.message}<br><br>OPML URL: ${opmlUrl}`, {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

// Parse OPML with DOMParser - more reliable
function parseOPML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const outlines = [...doc.querySelectorAll('outline')];
  return outlines.map(o => ({
    title: o.getAttribute('text') || o.getAttribute('title') || 'Untitled',
    link: o.getAttribute('htmlUrl') || o.getAttribute('url') || '#',
    rss: o.getAttribute('xmlUrl') || o.getAttribute('xmlurl')
  }));
}

// Parse RSS properly, get 10 posts
function parseRSS(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = [...doc.querySelectorAll('item')].slice(0, 10);
  
  return items.map(item => {
    const get = tag => item.querySelector(tag)?.textContent?.trim() || '';
    const desc = get('description').replace(/<[^>]+>/g,'').slice(0,160);
    return {
      title: get('title'),
      link: get('link'),
      desc: desc + (desc.length >= 160 ? '...' : ''),
      date: new Date(get('pubDate')).toLocaleDateString()
    };
  });
}

function htmlWithPosts(items, embed) {
  const css = embed? '' : `<style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:0 20px}
  h2{font-size:20px;margin:32px 0 12px}.post{margin:0 0 20px;padding-bottom:20px;border-bottom:1px solid #eee}
  h3{margin:0 0 6px;font-size:17px}.meta{color:#70757a;font-size:13px}.error{color:#d93025;font-size:13px}</style>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>
  ${embed? '' : '<h1>My Links</h1>'}
  ${items.map(i => `
    <h2><a href="${i.link}" target="_blank">${i.title}</a></h2>
    ${i.error ? `<div class="error">RSS Error: ${i.error}</div>` : ''}
    ${i.posts.map(p => `
      <div class="post">
        <h3><a href="${p.link}" target="_blank">${p.title}</a></h3>
        <div class="meta">${p.date}</div>
        <div>${p.desc}</div>
      </div>
    `).join('')}
  `).join('')}</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function rssResponse(items) {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>My Links</title><link>https://example.com</link>
  ${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link></item>`).join('')}
  </channel></rss>`;
  return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } });
}
