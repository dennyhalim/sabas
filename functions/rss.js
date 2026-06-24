/**
 * Cloudflare Pages RSS Reader
 *
 * Usage:
 *   GET /?opml=<url>                  → HTML (default)
 *   GET /?opml=<url>&format=rss       → Aggregated RSS feed
 *   GET /?opml=<url>&format=js        → JS embed snippet
 *   GET /?opml=<url>&format=iframe    → iFrame-embeddable HTML
 *   POST / (body = OPML text)         → same format param applies
 *
 * Deploy: place this file at functions/[[path]].js in a Cloudflare Pages project
 */

const READER_TITLE   = 'RSS Reader';
const MAX_PER_FEED   = 10;   // latest items kept per feed
const FETCH_TIMEOUT  = 8000; // ms per feed fetch

// ─────────────────────────────────────────────────────────────────────────────
// Tiny XML helpers (no DOMParser in Workers)
// ─────────────────────────────────────────────────────────────────────────────

/** Return the value of an XML attribute from a tag string. */
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2]) : null;
}

/** Return the inner text of the FIRST occurrence of <tag>…</tag>. */
function inner(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Return array of full <tag>…</tag> blocks. */
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

/** Strip CDATA wrappers. */
function cdata(s) {
  return (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Strip HTML tags. */
function nohtml(s) {
  return (s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Decode common HTML entities. */
function entities(s) {
  return (s ?? '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Full clean: CDATA → strip tags → entities. */
function clean(s) { return entities(cdata(s ?? '')); }

/** HTML-escape for safe output. */
function esc(s) {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format an ISO/RFC date string into a readable form. */
function fmtDate(s) {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return s; }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPML Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an OPML document and return an array of feed descriptors:
 *   { url, title, htmlUrl }
 */
function parseOPML(xml) {
  const feeds = [];
  const re = /<outline\b([^>]+)(?:\/>|>)/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag  = m[1];
    const url  = attr(tag, 'xmlUrl');
    if (!url) continue;
    feeds.push({
      url,
      title:   attr(tag, 'title') || attr(tag, 'text') || url,
      htmlUrl: attr(tag, 'htmlUrl') ?? null,
    });
  }
  return feeds;
}

// ─────────────────────────────────────────────────────────────────────────────
// RSS / Atom Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the "best" link from an Atom <entry> block.
 * Prefers rel="alternate" or no rel, falls back to <id>.
 */
function atomLink(block) {
  const re = /<link([^>]*)(?:\/>|>([^<]*))/gi;
  let m, fallback = null;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    const href  = attr(attrs, 'href');
    const rel   = attr(attrs, 'rel') || 'alternate';
    if (href) {
      if (rel === 'alternate' || rel === '') return href;
      if (!fallback) fallback = href;
    } else {
      const text = (m[2] ?? '').trim();
      if (text) return text;
    }
  }
  return fallback;
}

/**
 * Parse a fetched XML string into an array of post objects.
 * Detects RSS 2.0 vs Atom automatically.
 */
function parseFeed(xml, feed) {
  const isAtom = /<feed\b/.test(xml) &&
    /xmlns\s*=\s*["']https?:\/\/www\.w3\.org\/2005\/Atom["']/.test(xml);

  const posts = [];

  if (isAtom) {
    for (const blk of blocks(xml, 'entry').slice(0, MAX_PER_FEED)) {
      const title       = clean(inner(blk, 'title')  || '');
      const link        = atomLink(blk) || clean(inner(blk, 'id') || '');
      const rawContent  = inner(blk, 'content') || inner(blk, 'summary') || '';
      const description = nohtml(clean(rawContent)).slice(0, 280);
      const pubDate     = clean(inner(blk, 'published') || inner(blk, 'updated') || '');
      const id          = clean(inner(blk, 'id') || link);
      posts.push({ title, link, description, pubDate, id, feedTitle: feed.title, feedUrl: feed.htmlUrl || feed.url });
    }
  } else {
    for (const blk of blocks(xml, 'item').slice(0, MAX_PER_FEED)) {
      const title       = clean(inner(blk, 'title')   || '');
      const link        = clean(inner(blk, 'link')    || inner(blk, 'guid') || '');
      const rawContent  = inner(blk, 'content:encoded') || inner(blk, 'description') || '';
      const description = nohtml(clean(rawContent)).slice(0, 280);
      const pubDate     = clean(inner(blk, 'pubDate') || inner(blk, 'dc:date') || '');
      const id          = clean(inner(blk, 'guid')    || link);
      posts.push({ title, link, description, pubDate, id, feedTitle: feed.title, feedUrl: feed.htmlUrl || feed.url });
    }
  }

  return posts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed Fetcher
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'CF-RSS-Reader/1.0',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    const xml = await resp.text();
    clearTimeout(timer);
    return parseFeed(xml, feed);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output renderers
// ─────────────────────────────────────────────────────────────────────────────

/** Shared CSS for HTML and iframe modes */
const CSS = `
  :root {
    --bg:      #0d0f14;
    --card:    #13161f;
    --border:  #1e2233;
    --accent:  #f97316;   /* RSS orange */
    --accent2: #818cf8;   /* indigo for feed tags */
    --text:    #dde1f0;
    --muted:   #6b7094;
    --mono:    'JetBrains Mono', 'Fira Mono', monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 15px; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.65;
    min-height: 100vh;
  }
  a { color: inherit; text-decoration: none; }
  a:hover { color: var(--accent); }

  /* ── Layout ── */
  .shell   { display: flex; min-height: 100vh; }
  .sidebar {
    width: 220px; min-width: 220px;
    background: var(--card);
    border-right: 1px solid var(--border);
    padding: 1.75rem 1.25rem;
    display: flex; flex-direction: column; gap: 1.5rem;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .sidebar-logo {
    display: flex; align-items: center; gap: .5rem;
    font-size: .95rem; font-weight: 700; color: var(--accent);
    letter-spacing: .5px;
  }
  .sidebar-logo svg { flex-shrink: 0; }
  .sidebar-section { font-size: .68rem; text-transform: uppercase;
    letter-spacing: 1.2px; color: var(--muted); margin-bottom: .4rem; }
  .feed-list { list-style: none; display: flex; flex-direction: column; gap: .15rem; }
  .feed-list a {
    display: block; padding: .35rem .5rem;
    border-radius: 5px; font-size: .8rem; color: var(--muted);
    transition: background .15s, color .15s;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .feed-list a:hover { background: var(--border); color: var(--text); }
  .export-links { display: flex; flex-direction: column; gap: .3rem; margin-top: auto; }
  .export-links a {
    display: flex; align-items: center; gap: .45rem;
    padding: .4rem .65rem; border-radius: 6px;
    border: 1px solid var(--border); font-size: .75rem; color: var(--muted);
    transition: border-color .2s, color .2s;
  }
  .export-links a:hover { border-color: var(--accent); color: var(--accent); }

  /* ── Main ── */
  .main { flex: 1; padding: 2rem 2.5rem; max-width: 820px; }
  .page-header { margin-bottom: 1.75rem; }
  .page-header h1 { font-size: 1.35rem; font-weight: 700; }
  .page-header p  { font-size: .8rem; color: var(--muted); margin-top: .2rem;
    font-family: var(--mono); }

  /* ── Post card ── */
  .post {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.1rem 1.3rem;
    margin-bottom: .75rem;
    transition: border-color .2s, box-shadow .2s;
    background: var(--card);
  }
  .post:hover {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .post-feed {
    font-family: var(--mono);
    font-size: .68rem; letter-spacing: .6px;
    text-transform: uppercase;
    color: var(--accent2);
    margin-bottom: .3rem;
  }
  .post h2 { font-size: 1rem; font-weight: 600; margin-bottom: .25rem; }
  .post h2 a:hover { color: var(--accent); }
  .post-meta { font-size: .75rem; color: var(--muted); font-family: var(--mono); margin-bottom: .45rem; }
  .post-desc { font-size: .85rem; color: var(--muted); line-height: 1.55; }
  .post-desc::after { content: ' …'; }

  @media (max-width: 660px) {
    .sidebar { display: none; }
    .main { padding: 1.25rem; }
  }
`;

// ── HTML ──────────────────────────────────────────────────────────────────────

function renderHTML(posts, feeds, reqUrl) {
  const u   = new URL(reqUrl);
  const opml = u.searchParams.get('opml') || '';
  const mkUrl = (fmt) => {
    const nu = new URL(reqUrl);
    nu.searchParams.set('format', fmt);
    return esc(nu.toString());
  };

  const feedItems = feeds
    .map(f => `<li><a href="${esc(f.htmlUrl||f.url)}" target="_blank" title="${esc(f.title)}">${esc(f.title)}</a></li>`)
    .join('');

  const postCards = posts.length
    ? posts.map(p => `
      <article class="post">
        <div class="post-feed">${esc(p.feedTitle)}</div>
        <h2><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a></h2>
        <div class="post-meta">${fmtDate(p.pubDate)}</div>
        ${p.description ? `<p class="post-desc">${esc(p.description)}</p>` : ''}
      </article>`).join('')
    : `<p style="color:var(--muted);padding:2rem 0">No posts found. Check that your OPML URL is accessible.</p>`;

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(READER_TITLE)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="sidebar-logo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1" fill="currentColor"/>
      </svg>
      RSS Reader
    </div>
    <div>
      <div class="sidebar-section">Feeds</div>
      <ul class="feed-list">${feedItems}</ul>
    </div>
    <div class="export-links">
      <div class="sidebar-section">Export as</div>
      <a href="${mkUrl('rss')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>
          <circle cx="5" cy="19" r="1" fill="currentColor"/>
        </svg>
        RSS Feed
      </a>
      <a href="${mkUrl('js')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
        JS Embed
      </a>
      <a href="${mkUrl('iframe')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>
        </svg>
        iFrame Embed
      </a>
    </div>
  </nav>
  <main class="main">
    <header class="page-header">
      <h1>${esc(READER_TITLE)}</h1>
      <p>${posts.length} posts from ${feeds.length} feed${feeds.length === 1 ? '' : 's'}</p>
    </header>
    ${postCards}
  </main>
</div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Aggregated RSS ────────────────────────────────────────────────────────────

function renderRSS(posts, reqUrl) {
  const now = new Date().toUTCString();
  const items = posts.map(p => `
  <item>
    <title><![CDATA[${p.title}]]></title>
    <link>${esc(p.link)}</link>
    <guid isPermaLink="false"><![CDATA[${p.id || p.link}]]></guid>
    <pubDate>${p.pubDate ? new Date(p.pubDate).toUTCString() : now}</pubDate>
    <source><![CDATA[${p.feedTitle}]]></source>
    <description><![CDATA[${p.description}]]></description>
  </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${esc(READER_TITLE)} — Aggregated Feed</title>
  <link>${esc(reqUrl)}</link>
  <description>Aggregated RSS feed powered by Cloudflare Pages</description>
  <lastBuildDate>${now}</lastBuildDate>
  <atom:link href="${esc(reqUrl)}" rel="self" type="application/rss+xml"/>
  ${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}

// ── JS Embed ──────────────────────────────────────────────────────────────────
// Returns a <script> snippet users paste into any page. The script renders
// the feed list inline wherever a <div id="rss-reader"></div> exists.

function renderJS(posts, reqUrl) {
  const iframeUrl = new URL(reqUrl);
  iframeUrl.searchParams.set('format', 'iframe');

  const snippet = `<!-- RSS Reader embed -->
<div id="rss-reader"></div>
<script>
(function() {
  var src = ${JSON.stringify(iframeUrl.toString())};
  var el  = document.getElementById('rss-reader');
  if (!el) return;
  var f = document.createElement('iframe');
  f.src = src;
  f.style.cssText = 'width:100%;border:none;min-height:600px;';
  f.loading = 'lazy';
  f.title   = 'RSS Reader';
  f.onload  = function() {
    try {
      f.style.height = f.contentDocument.body.scrollHeight + 'px';
    } catch(e) {}
  };
  el.appendChild(f);
})();
<\/script>`;

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>JS Embed — ${esc(READER_TITLE)}</title>
<style>
  body { background:#0d0f14; color:#dde1f0; font-family:system-ui,sans-serif;
         display:flex; flex-direction:column; align-items:center;
         justify-content:flex-start; min-height:100vh; margin:0; padding:3rem 1.5rem; }
  h1  { font-size:1.1rem; color:#f97316; margin-bottom:.5rem; }
  p   { color:#6b7094; font-size:.85rem; margin-bottom:1.5rem; }
  pre { background:#13161f; border:1px solid #1e2233; border-radius:10px;
        padding:1.5rem; font-size:.82rem; line-height:1.6; white-space:pre-wrap;
        word-break:break-all; width:100%; max-width:700px; }
  button {
    margin-top:1rem; padding:.5rem 1.2rem; background:#f97316; border:none;
    border-radius:6px; color:#fff; font-size:.85rem; cursor:pointer; }
  button:hover { background:#ea6c0e; }
</style>
</head>
<body>
  <h1>JS Embed Snippet</h1>
  <p>Paste this into any HTML page where you want the reader to appear.</p>
  <pre id="snippet">${esc(snippet)}</pre>
  <button onclick="navigator.clipboard.writeText(document.getElementById('snippet').textContent)
    .then(()=>this.textContent='Copied!')">Copy to clipboard</button>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── iFrame embed ──────────────────────────────────────────────────────────────
// A minimal self-contained HTML page, suitable for embedding in an <iframe>.

function renderIframe(posts) {
  const items = posts.length
    ? posts.map(p => `
      <article class="post">
        <div class="post-feed">${esc(p.feedTitle)}</div>
        <h2><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a></h2>
        <div class="post-meta">${fmtDate(p.pubDate)}</div>
        ${p.description ? `<p class="post-desc">${esc(p.description)}</p>` : ''}
      </article>`).join('')
    : '<p style="color:#6b7094;padding:1rem">No posts found.</p>';

  const iframeCSS = `
    :root { --bg:#0d0f14; --card:#13161f; --border:#1e2233;
            --accent:#f97316; --accent2:#818cf8;
            --text:#dde1f0; --muted:#6b7094;
            --mono:'JetBrains Mono','Fira Mono',monospace; }
    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0 }
    body { background:var(--bg); color:var(--text);
           font-family:system-ui,-apple-system,sans-serif;
           line-height:1.6; padding:1rem; }
    a { color:inherit; text-decoration:none; }
    a:hover { color:var(--accent); }
    .post { background:var(--card); border:1px solid var(--border); border-radius:9px;
            padding:1rem 1.2rem; margin-bottom:.6rem;
            transition:border-color .2s; }
    .post:hover { border-color:var(--accent); }
    .post-feed { font-family:var(--mono); font-size:.65rem; letter-spacing:.6px;
                 text-transform:uppercase; color:var(--accent2); margin-bottom:.25rem; }
    .post h2 { font-size:.95rem; font-weight:600; margin-bottom:.2rem; }
    .post-meta { font-size:.7rem; color:var(--muted); font-family:var(--mono); margin-bottom:.35rem; }
    .post-desc { font-size:.82rem; color:var(--muted); }
    .post-desc::after { content:' …'; }
  `;

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(READER_TITLE)}</title>
<style>${iframeCSS}</style>
</head>
<body>${items}</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage / landing page (no OPML supplied)
// ─────────────────────────────────────────────────────────────────────────────

function renderUsage(host) {
  const base = `https://${host}/`;
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(READER_TITLE)} — Usage</title>
<style>
  :root { --bg:#0d0f14; --card:#13161f; --border:#1e2233;
          --accent:#f97316; --text:#dde1f0; --muted:#6b7094;
          --mono:'JetBrains Mono','Fira Mono',monospace; }
  * { box-sizing:border-box; margin:0; padding:0 }
  body { background:var(--bg); color:var(--text); font-family:system-ui,sans-serif;
         display:flex; flex-direction:column; align-items:center;
         justify-content:center; min-height:100vh; padding:2rem; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px;
          padding:2.5rem; max-width:680px; width:100%; }
  .logo { display:flex; align-items:center; gap:.6rem;
          color:var(--accent); font-size:1.2rem; font-weight:700; margin-bottom:1.5rem; }
  h2   { font-size:.85rem; color:var(--muted); text-transform:uppercase;
          letter-spacing:1px; margin:1.25rem 0 .5rem; }
  pre  { background:var(--bg); border:1px solid var(--border); border-radius:8px;
          padding:.9rem 1rem; font-family:var(--mono); font-size:.78rem;
          line-height:1.7; white-space:pre-wrap; word-break:break-all; color:#a5b4fc; }
  p    { font-size:.88rem; color:var(--muted); line-height:1.6; }
  .try { display:inline-block; margin-top:1.5rem; padding:.55rem 1.2rem;
          background:var(--accent); color:#fff; border-radius:7px;
          font-size:.85rem; text-decoration:none; }
  .try:hover { background:#ea6c0e; color:#fff; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
      <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>
      <circle cx="5" cy="19" r="1" fill="currentColor"/>
    </svg>
    RSS Reader
  </div>
  <p>A serverless RSS reader powered by Cloudflare Pages. Supply an OPML file URL to get started.</p>

  <h2>HTML (default)</h2>
  <pre>GET ${base}?opml=https://example.com/feeds.opml</pre>

  <h2>Aggregated RSS feed</h2>
  <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=rss</pre>

  <h2>JavaScript embed snippet</h2>
  <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=js</pre>

  <h2>iFrame-embeddable page</h2>
  <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=iframe</pre>

  <h2>POST (send OPML body directly)</h2>
  <pre>POST ${base}?format=html
Content-Type: text/xml

&lt;?xml version="1.0"?&gt;
&lt;opml version="2.0"&gt; … &lt;/opml&gt;</pre>
</div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequest({ request, env, params }) {
    const url    = new URL(request.url);
    const format = (url.searchParams.get('format') || 'html').toLowerCase();
    const opmlParam = url.searchParams.get('opml');

    // ── Obtain OPML ──────────────────────────────────────────────────────────
    let opmlText = null;

    if (request.method === 'POST') {
      try { opmlText = await request.text(); } catch { /* ignore */ }
    } else if (opmlParam) {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
        const resp  = await fetch(opmlParam, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'CF-RSS-Reader/1.0' },
        });
        clearTimeout(timer);
        opmlText = await resp.text();
      } catch (e) {
        return new Response(`Failed to fetch OPML: ${e.message}`, { status: 502 });
      }
    }

    if (!opmlText) {
      return renderUsage(url.host);
    }

    // ── Parse OPML ───────────────────────────────────────────────────────────
    const feeds = parseOPML(opmlText);
    if (feeds.length === 0) {
      return new Response('No feeds found in OPML (no <outline xmlUrl="…"> elements).', {
        status: 400, headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ── Fetch all feeds in parallel ──────────────────────────────────────────
    const results = await Promise.allSettled(feeds.map(f => fetchFeed(f)));

    // Flatten, keeping MAX_PER_FEED per feed, then sort newest-first globally
    const allPosts = results.flatMap((r, i) =>
      r.status === 'fulfilled' ? r.value.slice(0, MAX_PER_FEED) : []
    );
    allPosts.sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    });

    // ── Dispatch to renderer ─────────────────────────────────────────────────
    switch (format) {
      case 'rss':    return renderRSS(allPosts, url.toString());
      case 'js':     return renderJS(allPosts, url.toString());
      case 'iframe': return renderIframe(allPosts);
      default:       return renderHTML(allPosts, feeds, url.toString());
    }
}
