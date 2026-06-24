/**
 * Cloudflare Pages RSS Reader
 *
 * Place this file at: functions/[[path]].js
 * Add your feeds to:  feeds.opml  (project root, served as a static asset)
 *
 * GET  /                          → HTML reader (uses feeds.opml)
 * GET  /?opml=<url>               → HTML reader (remote OPML)
 * GET  /?opml=<url>&format=rss    → Aggregated RSS feed
 * GET  /?opml=<url>&format=js     → JS embed snippet
 * GET  /?opml=<url>&format=iframe → Bare HTML page for <iframe> embedding
 * POST /                          → Same formats; send OPML as request body
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const SITE_TITLE      = 'RSS Reader';
const MAX_PER_FEED    = 15;    // items to keep per feed before merging
const FETCH_TIMEOUT   = 8000;  // ms — abort slow feeds rather than stall
const EXCERPT_LENGTH  = 280;   // characters of plain-text excerpt to keep

const RSS_ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/xml, text/xml, */*';

// ─── XML utilities ────────────────────────────────────────────────────────────
//
// Cloudflare Workers don't expose DOMParser, so we use targeted regexes.
// These are intentionally narrow — they handle the specific constructs that
// appear in OPML, RSS 2.0, and Atom, not arbitrary XML.

/** Read an attribute value from a snippet of an opening tag. */
function xmlAttr(tagSnippet, attrName) {
  const pattern = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tagSnippet.match(pattern);
  return match ? (match[1] ?? match[2]) : null;
}

/** Return the text content of the first matching element, or null. */
function xmlText(source, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = source.match(pattern);
  return match ? match[1].trim() : null;
}

/** Return an array of full element strings matching a tag name. */
function xmlAll(source, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  return source.match(pattern) ?? [];
}

/** Unwrap CDATA sections: <![CDATA[...]]> → ... */
function stripCdata(text) {
  return (text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Remove all HTML/XML tags, collapsing whitespace. */
function stripTags(text) {
  return (text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Decode the handful of HTML entities that commonly appear in feed content. */
function decodeEntities(text) {
  return (text ?? '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,        (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex)  => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Fully clean a raw field value from feed XML:
 * strips CDATA wrappers, HTML tags, and decodes entities.
 */
function cleanField(raw) {
  return decodeEntities(stripCdata(raw ?? ''));
}

/** Escape a string for safe insertion into HTML attribute values or content. */
function htmlEscape(text) {
  return (text ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/** Format a date string for display, falling back to the raw value. */
function formatDate(dateString) {
  if (!dateString) return '';
  try {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return dateString;
  }
}

// ─── OPML parsing ─────────────────────────────────────────────────────────────

/**
 * Parse an OPML subscription list into an array of feed descriptors.
 * Only <outline> elements with an xmlUrl attribute are treated as feeds;
 * folder/category outlines (no xmlUrl) are silently skipped.
 *
 * Returns: Array<{ url, title, siteUrl }>
 */
function parseOpml(opmlText) {
  const title = cleanField(xmlText(opmlText, 'title')) || SITE_TITLE;

  const feeds = [];
  const outlinePattern = /<outline\b([^>]+)(?:\/>|>)/gi;
  let match;

  while ((match = outlinePattern.exec(opmlText)) !== null) {
    const attrs  = match[1];
    const xmlUrl = xmlAttr(attrs, 'xmlUrl');
    if (!xmlUrl) continue; // folder outline, not a feed

    feeds.push({
      url:     xmlUrl,
      title:   xmlAttr(attrs, 'title') || xmlAttr(attrs, 'text') || xmlUrl,
      siteUrl: xmlAttr(attrs, 'htmlUrl') ?? null,
    });
  }

  return { title, feeds };
}

// ─── Feed parsing ─────────────────────────────────────────────────────────────

/**
 * Detect whether an XML document is an Atom feed.
 * We check for both the <feed> root element and the Atom namespace to avoid
 * false-positives from RSS feeds that embed Atom namespace declarations.
 */
function isAtomFeed(xml) {
  return /<feed\b/.test(xml)
    && /xmlns\s*=\s*["']https?:\/\/www\.w3\.org\/2005\/Atom["']/.test(xml);
}

/**
 * Find the best link URL from an Atom <entry> block.
 *
 * Atom uses self-closing <link> tags with href/rel attributes rather than
 * text content. We prefer rel="alternate" (the human-readable page), then
 * any other href, then fall back to the <id> element.
 */
function extractAtomLink(entryBlock) {
  const linkPattern = /<link([^>]*)(?:\/>|>([^<]*))/gi;
  let fallbackHref = null;
  let match;

  while ((match = linkPattern.exec(entryBlock)) !== null) {
    const attrs = match[1];
    const href  = xmlAttr(attrs, 'href');
    const rel   = xmlAttr(attrs, 'rel') ?? 'alternate';

    if (href) {
      if (rel === 'alternate' || rel === '') return href; // ideal match
      fallbackHref ??= href;                              // keep as fallback
    } else {
      const inlineText = (match[2] ?? '').trim();
      if (inlineText) return inlineText; // plain-text <link>url</link>
    }
  }

  return fallbackHref;
}

/**
 * Build a plain-text excerpt from raw HTML/XML feed content.
 * Strips markup, cleans entities, and trims to EXCERPT_LENGTH chars.
 */
function buildExcerpt(rawContent) {
  return stripTags(cleanField(rawContent)).slice(0, EXCERPT_LENGTH);
}

/** Parse a single Atom <entry> block into a post object. */
function parseAtomEntry(entryBlock, feed) {
  const rawContent = xmlText(entryBlock, 'content') ?? xmlText(entryBlock, 'summary') ?? '';

  return {
    title:       cleanField(xmlText(entryBlock, 'title')),
    link:        extractAtomLink(entryBlock) ?? cleanField(xmlText(entryBlock, 'id')),
    excerpt:     buildExcerpt(rawContent),
    pubDate:     cleanField(xmlText(entryBlock, 'published') ?? xmlText(entryBlock, 'updated')),
    id:          cleanField(xmlText(entryBlock, 'id')),
    feedTitle:   feed.title,
    feedSiteUrl: feed.siteUrl ?? feed.url,
  };
}

/** Parse a single RSS <item> block into a post object. */
function parseRssItem(itemBlock, feed) {
  const link       = cleanField(xmlText(itemBlock, 'link') ?? xmlText(itemBlock, 'guid'));
  const rawContent = xmlText(itemBlock, 'content:encoded') ?? xmlText(itemBlock, 'description') ?? '';

  return {
    title:       cleanField(xmlText(itemBlock, 'title')),
    link,
    excerpt:     buildExcerpt(rawContent),
    pubDate:     cleanField(xmlText(itemBlock, 'pubDate') ?? xmlText(itemBlock, 'dc:date')),
    id:          cleanField(xmlText(itemBlock, 'guid')) || link,
    feedTitle:   feed.title,
    feedSiteUrl: feed.siteUrl ?? feed.url,
  };
}

/**
 * Parse a fetched feed XML string into an array of post objects.
 * Auto-detects Atom vs RSS 2.0.
 */
function parseFeedXml(xml, feed) {
  if (isAtomFeed(xml)) {
    return xmlAll(xml, 'entry')
      .slice(0, MAX_PER_FEED)
      .map(entry => parseAtomEntry(entry, feed));
  }

  return xmlAll(xml, 'item')
    .slice(0, MAX_PER_FEED)
    .map(item => parseRssItem(item, feed));
}

// ─── Feed fetching ────────────────────────────────────────────────────────────

/**
 * Fetch a single feed and return its parsed posts.
 * Returns an empty array on timeout or any network/parse error
 * so one bad feed never blocks the rest.
 */
async function fetchAndParseFeed(feed) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(feed.url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'CF-RSS-Reader/1.0', 'Accept': RSS_ACCEPT_HEADER },
    });
    const xml = await response.text();
    clearTimeout(timeout);
    return parseFeedXml(xml, feed);
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

/**
 * Fetch all feeds in parallel, then merge and sort posts newest-first.
 * Failed individual feeds are silently dropped.
 */
async function fetchAllFeeds(feeds) {
  const results = await Promise.allSettled(feeds.map(fetchAndParseFeed));

  const allPosts = results.flatMap(result =>
    result.status === 'fulfilled' ? result.value : []
  );

  allPosts.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return dateB - dateA; // newest first
  });

  return allPosts;
}

// ─── OPML loading ─────────────────────────────────────────────────────────────

/** Load OPML from the POST request body. */
async function loadOpmlFromBody(request) {
  try { return await request.text(); } catch { return null; }
}

/** Fetch OPML from a remote URL supplied via ?opml= query param. */
async function loadOpmlFromUrl(opmlUrl) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(opmlUrl, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'CF-RSS-Reader/1.0' },
    });
    clearTimeout(timeout);
    return await response.text();
  } catch (error) {
    clearTimeout(timeout);
    throw error; // re-throw so the handler can return a 502
  }
}

/**
 * Try to load /feeds.opml from the Pages static asset store.
 * env.ASSETS is the binding Cloudflare Pages injects for static files.
 */
async function loadLocalOpml(env, originUrl) {
  if (!env.ASSETS) return null;
  try {
    const assetUrl  = new URL('/feeds.opml', originUrl);
    const response  = await env.ASSETS.fetch(new Request(assetUrl.toString()));
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const THEME = `
  :root {
    --bg:       #0d0f14;
    --surface:  #13161f;
    --border:   #1e2233;
    --accent:   #f97316;  /* RSS orange */
    --tag:      #818cf8;  /* indigo for feed labels */
    --text:     #dde1f0;
    --muted:    #6b7094;
    --mono:     'JetBrains Mono', 'Fira Mono', monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color:      var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.65;
  }
  a { color: inherit; text-decoration: none; }
  a:hover { color: var(--accent); }
`;

const POST_CARD_STYLES = `
  .post {
    background: var(--surface);
    border:     1px solid var(--border);
    border-radius: 10px;
    padding:    1.1rem 1.3rem;
    margin-bottom: .75rem;
    transition: border-color .2s, box-shadow .2s;
  }
  .post:hover {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .post-feed {
    font-family: var(--mono);
    font-size:   .68rem;
    letter-spacing: .6px;
    text-transform: uppercase;
    color:       var(--tag);
    margin-bottom: .3rem;
  }
  .post h2 { font-size: 1rem; font-weight: 600; margin-bottom: .25rem; }
  .post h2 a:hover { color: var(--accent); }
  .post-date {
    font-family: var(--mono);
    font-size:   .75rem;
    color:       var(--muted);
    margin-bottom: .45rem;
  }
  .post-excerpt { font-size: .85rem; color: #9ba3c2; line-height: 1.55; }
  .post-excerpt::after { content: ' …'; }

  /* ── Compact mode ── */
  .post.compact {
    padding:       .55rem 1rem;
    margin-bottom: .3rem;
    border-radius: 7px;
    display:       flex;
    align-items:   baseline;
    gap:           .75rem;
  }
  .post.compact .post-feed {
    flex-shrink:  0;
    margin-bottom: 0;
  }
  .post.compact h2 { font-size: .9rem; margin-bottom: 0; }
`;

// ─── HTML renderer ────────────────────────────────────────────────────────────

/** Render a single post card, shared between HTML and iframe output. */
function renderPostCard(post, compact = false) {
  if (compact) {
    return `
    <article class="post compact">
      <div class="post-feed">${htmlEscape(post.feedTitle)}</div>
      <h2><a href="${htmlEscape(post.link)}" target="_blank" rel="noopener">${htmlEscape(post.title)}</a></h2>
    </article>`;
  }

  const excerpt = post.excerpt
    ? `<p class="post-excerpt">${htmlEscape(post.excerpt)}</p>`
    : '';

  return `
    <article class="post">
      <div class="post-feed">${htmlEscape(post.feedTitle)}</div>
      <h2><a href="${htmlEscape(post.link)}" target="_blank" rel="noopener">${htmlEscape(post.title)}</a></h2>
      <div class="post-date">${formatDate(post.pubDate)}</div>
      ${excerpt}
    </article>`;
}

function renderHtmlPage(posts, feeds, requestUrl, title) {
  const currentUrl = new URL(requestUrl);
  const compact    = currentUrl.searchParams.get('compact') === '1';

  const formatUrl = (format) => {
    const url = new URL(requestUrl);
    url.searchParams.set('format', format);
    return htmlEscape(url.toString());
  };

  const toggleCompactUrl = () => {
    const url = new URL(requestUrl);
    if (compact) url.searchParams.delete('compact');
    else         url.searchParams.set('compact', '1');
    return htmlEscape(url.toString());
  };

  const feedListHtml = feeds
    .map(f => `<li><a href="${htmlEscape(f.siteUrl || f.url)}" target="_blank" title="${htmlEscape(f.title)}">${htmlEscape(f.title)}</a></li>`)
    .join('');

  const postCardsHtml = posts.length
    ? posts.map(p => renderPostCard(p, compact)).join('')
    : `<p style="color:var(--muted); padding: 2rem 0">No posts found. Check that your OPML is accessible and your feeds are reachable.</p>`;

  const rssIcon   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1" fill="currentColor"/></svg>`;
  const codeIcon  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  const frameIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    ${THEME}
    ${POST_CARD_STYLES}

    .layout {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
    }

    /* ── Sidebar ── */
    .sidebar {
      background:   var(--surface);
      border-right: 1px solid var(--border);
      padding:      1.75rem 1.25rem;
      display:      flex;
      flex-direction: column;
      gap:          1.5rem;
      position:     sticky;
      top:          0;
      height:       100vh;
      overflow-y:   auto;
    }
    .sidebar-logo {
      display:     flex;
      align-items: center;
      gap:         .5rem;
      font-size:   .95rem;
      font-weight: 700;
      color:       var(--accent);
    }
    .sidebar-label {
      font-size:       .68rem;
      text-transform:  uppercase;
      letter-spacing:  1.2px;
      color:           var(--muted);
      margin-bottom:   .4rem;
    }
    .feed-list { list-style: none; display: flex; flex-direction: column; gap: .15rem; }
    .feed-list a {
      display:       block;
      padding:       .35rem .5rem;
      border-radius: 5px;
      font-size:     .8rem;
      color:         var(--muted);
      white-space:   nowrap;
      overflow:      hidden;
      text-overflow: ellipsis;
      transition:    background .15s, color .15s;
    }
    .feed-list a:hover { background: var(--border); color: var(--text); }

    .export-section { margin-top: auto; display: flex; flex-direction: column; gap: .3rem; }
    .export-link {
      display:       flex;
      align-items:   center;
      gap:           .45rem;
      padding:       .4rem .65rem;
      border:        1px solid var(--border);
      border-radius: 6px;
      font-size:     .75rem;
      color:         var(--muted);
      transition:    border-color .2s, color .2s;
    }
    .export-link:hover { border-color: var(--accent); color: var(--accent); }
    .export-link.active { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }

    /* ── Main ── */
    .main { padding: 2rem 2.5rem; max-width: 820px; }
    .page-header { margin-bottom: 1.75rem; }
    .page-header h1 { font-size: 1.35rem; font-weight: 700; }
    .page-header p {
      font-family: var(--mono);
      font-size:   .8rem;
      color:       var(--muted);
      margin-top:  .2rem;
    }

    @media (max-width: 660px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .main { padding: 1.25rem; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>
          <circle cx="5" cy="19" r="1" fill="currentColor"/>
        </svg>
        ${htmlEscape(title)}
      </div>

      <div>
        <div class="sidebar-label">Feeds</div>
        <ul class="feed-list">${feedListHtml}</ul>
      </div>

      <div class="export-section">
        <div class="sidebar-label">View</div>
        <a class="export-link${compact ? ' active' : ''}" href="${toggleCompactUrl()}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          ${compact ? 'Full view' : 'Compact view'}
        </a>
        <div class="sidebar-label" style="margin-top:.75rem">Export as</div>
        <a class="export-link" href="${formatUrl('rss')}">${rssIcon} RSS Feed</a>
        <a class="export-link" href="${formatUrl('js')}">${codeIcon} JS Embed</a>
        <a class="export-link" href="${formatUrl('iframe')}">${frameIcon} iFrame</a>
      </div>
    </nav>

    <main class="main">
      <header class="page-header">
        <h1>${htmlEscape(title)}</h1>
        <p>${posts.length} post${posts.length === 1 ? '' : 's'} from ${feeds.length} feed${feeds.length === 1 ? '' : 's'}</p>
      </header>
      ${postCardsHtml}
    </main>
  </div>
  <img src="https://counter11.optistats.ovh/private/freecounterstat.php?c=tu39n5z56tu56f9judearse1aum3c4qa" border="0" title="free page counter html code" alt="free page counter html code">
    <script data-goatcounter="https://diselamatkan.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>
</body>
</html>`;
}

// ─── RSS renderer ─────────────────────────────────────────────────────────────

function renderRssFeed(posts, requestUrl, title) {
  const now      = new Date().toUTCString();
  const selfLink = htmlEscape(requestUrl);

  const items = posts.map(post => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${htmlEscape(post.link)}</link>
      <guid isPermaLink="false"><![CDATA[${post.id || post.link}]]></guid>
      <pubDate>${post.pubDate ? new Date(post.pubDate).toUTCString() : now}</pubDate>
      <source><![CDATA[${post.feedTitle}]]></source>
      <description><![CDATA[${post.excerpt}]]></description>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${htmlEscape(title)} — Aggregated Feed</title>
    <link>${selfLink}</link>
    <description>Aggregated RSS feed</description>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${selfLink}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}

// ─── JS embed renderer ────────────────────────────────────────────────────────

function renderJsEmbed(requestUrl, title) {
  // Point the snippet at the iframe format of this same URL
  const iframeUrl = new URL(requestUrl);
  iframeUrl.searchParams.set('format', 'iframe');

  const snippet = `<!-- RSS Reader embed -->
<div id="rss-reader"></div>
<script>
(function () {
  var container = document.getElementById('rss-reader');
  if (!container) return;

  var iframe = document.createElement('iframe');
  iframe.src             = ${JSON.stringify(iframeUrl.toString())};
  iframe.loading         = 'lazy';
  iframe.title           = 'RSS Reader';
  iframe.scrolling       = 'no';
  iframe.style.cssText   = 'width:100%; border:none; display:block; overflow:hidden;';

  // Receive height reports from the iframe and resize to fit.
  // postMessage works cross-origin; the iframe sends rssReaderHeight on load
  // and whenever its content changes (e.g. fonts, images, ResizeObserver).
  window.addEventListener('message', function (e) {
    if (e.source === iframe.contentWindow && e.data && e.data.rssReaderHeight) {
      iframe.style.height = e.data.rssReaderHeight + 'px';
    }
  });

  container.appendChild(iframe);
})();
<\/script>`;

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JS Embed — ${htmlEscape(title)}</title>
  <style>
    ${THEME}
    body {
      display:         flex;
      flex-direction:  column;
      align-items:     center;
      min-height:      100vh;
      padding:         3rem 1.5rem;
    }
    h1  { font-size: 1.1rem; color: var(--accent); margin-bottom: .5rem; }
    p   { color: var(--muted); font-size: .85rem; margin-bottom: 1.5rem; }
    pre {
      background:    var(--surface);
      border:        1px solid var(--border);
      border-radius: 10px;
      padding:       1.5rem;
      font-size:     .82rem;
      line-height:   1.6;
      white-space:   pre-wrap;
      word-break:    break-all;
      width:         100%;
      max-width:     700px;
    }
    button {
      margin-top:    1rem;
      padding:       .5rem 1.2rem;
      background:    var(--accent);
      border:        none;
      border-radius: 6px;
      color:         #fff;
      font-size:     .85rem;
      cursor:        pointer;
    }
    button:hover { background: #ea6c0e; }
  </style>
</head>
<body>
  <h1>JS Embed Snippet</h1>
  <p>Paste this into any HTML page to embed the reader inline.</p>
  <pre id="snippet">${htmlEscape(snippet)}</pre>
  <button onclick="
    navigator.clipboard
      .writeText(document.getElementById('snippet').textContent)
      .then(() => this.textContent = 'Copied!')
  ">Copy to clipboard</button>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── iFrame renderer ──────────────────────────────────────────────────────────

function renderIframePage(posts, title, compact = false) {
  const postCardsHtml = posts.length
    ? posts.map(p => renderPostCard(p, compact)).join('')
    : '<p style="color:var(--muted); padding:1rem">No posts found.</p>';

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    ${THEME}
    ${POST_CARD_STYLES}
    body { padding: 1rem; }

    /* Compact rows wrap to two lines on narrow widths */
    @media (max-width: 480px) {
      .post.compact { flex-wrap: wrap; }
      .post.compact .post-feed { width: 100%; margin-bottom: .1rem; }
    }
  </style>
</head>
<body>
  ${postCardsHtml}
  <script>
    // Tell the parent frame our real scroll height so it can resize us.
    // Works cross-origin because we're sending, not reading.
    function reportHeight() {
      var h = document.documentElement.scrollHeight;
      window.parent.postMessage({ rssReaderHeight: h }, '*');
    }
    reportHeight();
    // Re-report if images or fonts shift layout after load
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(reportHeight).observe(document.body);
    }
  <\/script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── Usage / landing page ─────────────────────────────────────────────────────

function renderUsagePage(host) {
  const base = `https://${host}/`;

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(SITE_TITLE)} — Setup</title>
  <style>
    ${THEME}
    body {
      display:         flex;
      flex-direction:  column;
      align-items:     center;
      justify-content: center;
      min-height:      100vh;
      padding:         2rem;
    }
    .card {
      background:    var(--surface);
      border:        1px solid var(--border);
      border-radius: 14px;
      padding:       2.5rem;
      max-width:     680px;
      width:         100%;
    }
    .logo {
      display:      flex;
      align-items:  center;
      gap:          .6rem;
      color:        var(--accent);
      font-size:    1.2rem;
      font-weight:  700;
      margin-bottom: 1.5rem;
    }
    h2  {
      font-size:       .85rem;
      color:           var(--muted);
      text-transform:  uppercase;
      letter-spacing:  1px;
      margin:          1.25rem 0 .5rem;
    }
    p   { font-size: .88rem; color: var(--muted); line-height: 1.6; }
    pre {
      background:    var(--bg);
      border:        1px solid var(--border);
      border-radius: 8px;
      padding:       .9rem 1rem;
      font-family:   var(--mono);
      font-size:     .78rem;
      line-height:   1.7;
      white-space:   pre-wrap;
      word-break:    break-all;
      color:         #a5b4fc;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>
        <circle cx="5" cy="19" r="1" fill="currentColor"/>
      </svg>
      ${htmlEscape(SITE_TITLE)}
    </div>

    <p>Add a <code>feeds.opml</code> file to your project root, or pass <code>?opml=&lt;url&gt;</code> to load feeds from a remote OPML file.</p>

    <h2>HTML reader (default)</h2>
    <pre>GET ${base}?opml=https://example.com/feeds.opml</pre>

    <h2>Aggregated RSS feed</h2>
    <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=rss</pre>

    <h2>JavaScript embed snippet</h2>
    <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=js</pre>

    <h2>iFrame-embeddable page</h2>
    <pre>GET ${base}?opml=https://example.com/feeds.opml&amp;format=iframe</pre>

    <h2>POST with OPML body</h2>
    <pre>POST ${base}?format=html
Content-Type: text/xml

&lt;?xml version="1.0"?&gt;
&lt;opml version="2.0"&gt; … &lt;/opml&gt;</pre>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── Request handler ──────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  const url     = new URL(request.url);
  const format  = (url.searchParams.get('format') ?? 'html').toLowerCase();
  const compact = url.searchParams.get('compact') === '1';

  // ── Step 1: Load OPML from whichever source is available ──────────────────

  let opmlText = null;

  if (request.method === 'POST') {
    opmlText = await loadOpmlFromBody(request);

  } else if (url.searchParams.has('opml')) {
    try {
      opmlText = await loadOpmlFromUrl(url.searchParams.get('opml'));
    } catch (error) {
      return new Response(`Could not fetch OPML: ${error.message}`, { status: 502 });
    }

  } else {
    // No explicit source — try the bundled feeds.opml static asset
    opmlText = await loadLocalOpml(env, url.origin);
  }

  if (!opmlText) {
    return renderUsagePage(url.host);
  }

  // ── Step 2: Parse the OPML into a feed list ───────────────────────────────

  const { title, feeds } = parseOpml(opmlText);

  if (feeds.length === 0) {
    return new Response(
      'No feeds found. OPML must contain <outline> elements with an xmlUrl attribute.',
      { status: 400, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  // ── Step 3: Fetch all feeds and collect posts ─────────────────────────────

  const posts = await fetchAllFeeds(feeds);

  // ── Step 4: Render in the requested format ────────────────────────────────

  switch (format) {
    case 'rss':
      return renderRssFeed(posts, url.toString(), title);

    case 'js':
      return renderJsEmbed(url.toString(), title);

    case 'iframe':
      return renderIframePage(posts, title, compact);

    default:
      return new Response(renderHtmlPage(posts, feeds, url.toString(), title), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
  }
}
