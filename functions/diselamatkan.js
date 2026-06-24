export async function onRequest(context) {
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'html';
  const opmlUrl = url.searchParams.get('url') || 'https://raw.githubusercontent.com/dennyhalim/alkitabiah/refs/heads/master/alkitabiah.opml';

  const res = await fetch(opmlUrl, { cf: { cacheTtl: 3600 } }); // 1hr cache
  if (!res.ok) return new Response('OPML not found', { status: 404 });

  const items = parseOPML(await res.text());

  if (format === 'rss') return rssResponse(items);
  if (format === 'embed') return htmlResponse(items, true, false);

  // HTML with posts: fetch RSS for each item with xmlUrl
  const itemsWithPosts = await Promise.all(items.map(async item => {
    if (!item.rss) return {...item, posts: [] };

    try {
      const r = await fetch(item.rss, {
        cf: { cacheTtl: 600 }, // cache RSS 10min
        headers: { 'User-Agent': 'Cloudflare-OPML-Reader' }
      });
      const xml = await r.text();

      // Grab 10 latest <item> from RSS
      const posts = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
       .slice(0, 10)
       .map(m => {
          const itemXml = m[1];
          const get = tag => {
            const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[(.*?)\\]\\]>|([^<]*))<\\/${tag}>`, 's');
            const match = itemXml.match(re);
            return (match?.[1] || match?.[2] || '').trim();
          };
          return {
            title: get('title'),
            link: get('link'),
            desc: get('description').replace(/<[^>]+>/g,'').slice(0,160) + '...',
            date: new Date(get('pubDate')).toLocaleDateString()
          };
        });
      return {...item, posts };
    } catch {
      return {...item, posts: [] }
    }
  }));

  return htmlWithPosts(itemsWithPosts, format === 'embed');
}

function parseOPML(xml) {
  const items = [];
  const regex = /<outline[^>]*text="([^"]*)"[^>]*(?:htmlUrl="([^"]*)")?[^>]*(?:xmlUrl="([^"]*)")?[^>]*>/g;
  let match;
  while ((match = regex.exec(xml))!== null) {
    items.push({
      title: match[1],
      link: match[2] || match[3] || '#',
      rss: match[3] || null
    });
  }
  return items;
}

function htmlWithPosts(items, embed) {
  const css = embed? '' : `
    <style>body{font:16px/1.6 system-ui;max-width:720px;margin:60px auto;padding:0 20px;color:#202124}
    h1{margin:0 0 32px}h2{font-size:20px;margin:32px 0 12px}a{color:#1a73e8;text-decoration:none}
    a:hover{text-decoration:underline}.post{margin:0 0 20px;padding:0 0 20px;border-bottom:1px solid #eee}
   .post h3{margin:0 0 6px;font-size:17px}.meta{color:#70757a;font-size:13px;margin:0 0 8px}
   .desc{color:#4d5156;font-size:15px}</style>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${css}<title>Links + Posts</title></head><body>
    ${embed? '' : '<h1>My Links</h1>'}
    ${items.map(i => `
      <h2><a href="${i.link}" target="_blank">${i.title}</a></h2>
      ${i.posts.length? i.posts.map(p => `
        <div class="post">
          <h3><a href="${p.link}" target="_blank">${p.title}</a></h3>
          <div class="meta">${p.date}</div>
          <div class="desc">${p.desc}</div>
        </div>
      `).join('') : '<div class="meta">No RSS feed</div>'}
    `).join('')}
    </body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function rssResponse(items) {
  const now = new Date().toUTCString();
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel>
  <title>My Links</title><link>https://example.com</link>
  <description>Links from OPML</description><lastBuildDate>${now}</lastBuildDate>
  ${items.map(i => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><guid>${i.link}</guid></item>`).join('')}
  </channel></rss>`;
  return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}

function htmlResponse(items, embed, withPosts) {
  return withPosts? htmlWithPosts(items, embed) : htmlWithPosts(items.map(i=>({...i,posts:[]})), embed);
}
