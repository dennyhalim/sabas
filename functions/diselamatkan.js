export async function onRequest(context) {
  const url = new URL(context.request.url);
  const format = url.searchParams.get('format') || 'html';
  const opmlUrl = url.searchParams.get('url') || 'https://raw.githubusercontent.com/dennyhalim/alkitabiah/refs/heads/master/alkitabiah.opml';

  // Fetch OPML
  const res = await fetch(opmlUrl);
  if (!res.ok) return new Response('OPML not found', { status: 404 });

  const opmlText = await res.text();
  const items = parseOPML(opmlText);

  // Route by format
  if (format === 'rss') return rssResponse(items);
  if (format === 'embed') return htmlResponse(items, true);
  return htmlResponse(items, false);
}

// Parse OPML <outline text="" htmlUrl="" xmlUrl="">
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

// Default HTML output
function htmlResponse(items, embed) {
  const css = embed? '' : `
    <style>body{font:16px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 20px}
    a{color:#1a73e8;text-decoration:none;display:block;padding:12px 0;border-bottom:1px solid #eee}
    a:hover{text-decoration:underline}h1{margin:0 0 24px}</style>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${css}<title>Links</title></head><body>
    ${embed? '' : '<h1>My Links</h1>'}
    ${items.map(i => `<a href="${i.link}" target="_blank" rel="noopener">${i.title}</a>`).join('')}
    </body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// RSS 2.0 output
function rssResponse(items) {
  const now = new Date().toUTCString();
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel>
  <title>My Links</title>
  <link>https://example.com</link>
  <description>Link list from OPML</description>
  <lastBuildDate>${now}</lastBuildDate>
  ${items.map(i => `
    <item>
      <title><![CDATA[${i.title}]]></title>
      <link>${i.link}</link>
      <guid>${i.link}</guid>
    </item>`).join('')}
  </channel></rss>`;

  return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
