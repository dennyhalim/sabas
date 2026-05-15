// functions/opds.js
// Rename file ini jadi apapun: books.xml.js, feed.js, katalog.js -> URL ikut berubah
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const category = url.searchParams.get('cat');
  const tag = url.searchParams.get('tag');
  const query = url.searchParams.get('q')?.trim() || '';
  const noCache = url.searchParams.get('nocache') === '1';

  const FEED_TITLE = env.FEED_TITLE || 'My Book Catalog';
  const FEED_AUTHOR = env.FEED_AUTHOR || 'Your Library';
  const BASE_URL = url.origin;
  const SCRIPT_PATH = url.pathname; // /opds, /books.xml, /feed, dll
  const CSV_URL = env.CSV_URL || `https://docs.google.com/spreadsheets/d/e/2PACX-1vTTcNN6fmETWj5DDNC-FGSkdmD-8jCspO1dbMTweH4OjUM8ofBCuUR0NA7VfyLJG8ho-hPp6aT_AJbb/pub?gid=0&single=true&output=csv`;

  // === GET CSV ===
  let csvData;
  try {
    const res = await fetch(CSV_URL, {
      cf: { cacheTtl: noCache? 0 : 300 },
      headers: { 'User-Agent': 'Cloudflare-Pages-OPDS/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csvData = await res.text();
  } catch (e) {
    return new Response(`Error: Cannot fetch CSV from ${CSV_URL}. ${e.message}`, { status: 500 });
  }

  // === PARSE CSV ===
  const lines = csvData.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift());
  const headerCount = headers.length;

  const books = [];
  const opdsLinks = [];
  const allCategories = {};
  const allTags = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseCsvLine(line);
    if (row.length!== headerCount ||!row[0]) continue;

    const item = Object.fromEntries(headers.map((h, i) => [h, row[i]?.trim() || '']));
    item.tags = item.tags? item.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    item.opds_url = item.opds_url?.trim() || '';

    if (item.opds_url) {
      item.category = '_OPDS_LINKS';
      opdsLinks.push(item);
    } else {
      item.category = item.category || 'Uncategorized';
      books.push(item);
      allCategories[item.category] = true;
      item.tags.forEach(t => allTags[t] = true);
    }
  }

  // === FILTER ===
  let filteredBooks = [...books];
  let filteredOpdsLinks = [...opdsLinks];
  let feedTitle = FEED_TITLE;

  if (category) {
    const c = category.toLowerCase();
    filteredBooks = filteredBooks.filter(b => b.category.toLowerCase() === c);
    filteredOpdsLinks = filteredOpdsLinks.filter(l => l.category.toLowerCase() === c);
    feedTitle = `${FEED_TITLE} - ${category}`;
  } else if (tag) {
    filteredBooks = filteredBooks.filter(b => b.tags.includes(tag));
    filteredOpdsLinks = filteredOpdsLinks.filter(l => l.tags.includes(tag));
    feedTitle = `${FEED_TITLE} - Tag: ${tag}`;
  } else if (query) {
    const q = query.toLowerCase();
    const match = b => `${b.title} ${b.author} ${b.summary} ${b.tags.join(' ')}`.toLowerCase().includes(q);
    filteredBooks = filteredBooks.filter(match);
    filteredOpdsLinks = filteredOpdsLinks.filter(match);
    feedTitle = `${FEED_TITLE} - Search: ${query}`;
  }

  // === BUILD OPDS XML ===
  const updated = new Date().toISOString();
  const params = new URLSearchParams({...(category && { cat: category }),...(tag && { tag }),...(query && { q: query }) });
  const selfUrl = `${BASE_URL}${SCRIPT_PATH}${params.toString()? '?' + params : ''}`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${escapeXml(selfUrl)}</id>
  <title>${escapeXml(feedTitle)}</title>
  <updated>${updated}</updated>
  <author><name>${escapeXml(FEED_AUTHOR)}</name></author>
  <link href="${escapeXml(selfUrl)}" rel="self" type="application/atom+xml;profile=opds-catalog;kind=${category||tag||query?'acquisition':'navigation'}"/>
  <link href="${BASE_URL}${SCRIPT_PATH}" rel="start" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link href="${BASE_URL}${SCRIPT_PATH}?q={searchTerms}" rel="search" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
`;

  if (!category &&!tag &&!query) {
    Object.keys(allCategories).sort().forEach(cat => {
      if (cat === '_OPDS_LINKS') return;
      const count = books.filter(b => b.category === cat).length;
      xml += ` <entry>
    <id>urn:category:${md5(cat)}</id>
    <title>${escapeXml(cat)}</title>
    <updated>${updated}</updated>
    <link href="${BASE_URL}${SCRIPT_PATH}?cat=${encodeURIComponent(cat)}" rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    <content>${count} books</content>
  </entry>
`;
    });
    Object.keys(allTags).sort().slice(0, 20).forEach(t => {
      xml += ` <link href="${BASE_URL}${SCRIPT_PATH}?tag=${encodeURIComponent(t)}" rel="http://opds-spec.org/facet" opds:facetGroup="Tags" title="${escapeXml(t)}"/>
`;
    });
  }

  if ((query || category || tag) && filteredBooks.length === 0 && filteredOpdsLinks.length === 0) {
    xml += ` <entry><id>urn:no-results</id><title>No results found</title><updated>${updated}</updated></entry>
`;
  }

  filteredBooks.forEach(book => {
    xml += ` <entry>
    <id>urn:uuid:${escapeXml(book.id || crypto.randomUUID())}</id>
    <title>${escapeXml(book.title || 'Untitled')}</title>
    <updated>${updated}</updated>
    <author><name>${escapeXml(book.author || 'Unknown')}</name></author>
    ${book.language? `<dc:language>${escapeXml(book.language)}</dc:language>` : ''}
    ${book.published? `<dc:issued>${escapeXml(book.published)}</dc:issued>` : ''}
    <category term="${escapeXml(book.category)}" label="${escapeXml(book.category)}"/>
    ${book.tags.map(t => `<category term="${escapeXml(t)}" label="${escapeXml(t)}"/>`).join('')}
    ${book.summary? `<summary>${escapeXml(book.summary)}</summary>` : ''}
    ${book.cover_url? `<link href="${escapeXml(book.cover_url)}" rel="http://opds-spec.org/image" type="image/jpeg"/>
    <link href="${escapeXml(book.cover_url)}" rel="http://opds-spec.org/image/thumbnail" type="image/jpeg"/>` : ''}
    ${book.download_url? `<link href="${escapeXml(book.download_url)}" rel="http://opds-spec.org/acquisition" type="${getMimeType(book.download_url)}"/>` : ''}
  </entry>
`;
  });

  filteredOpdsLinks.forEach(link => {
    xml += ` <entry>
    <id>urn:external:${md5(link.opds_url)}</id>
    <title>📚 ${escapeXml(link.title)}</title>
    <updated>${updated}</updated>
    ${link.author? `<author><name>${escapeXml(link.author)}</name></author>` : ''}
    ${link.summary? `<summary>${escapeXml(link.summary)}</summary>` : ''}
    <link href="${escapeXml(link.opds_url)}" rel="subsection" type="application/atom+xml;profile=opds-catalog"/>
  </entry>
`;
  });

  xml += `</feed>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      'Cache-Control': noCache? 'no-cache' : 'public, max-age=300',
      'X-Script-Path': SCRIPT_PATH
    }
  });
}

function parseCsvLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes =!inQuotes;
    } else if (char === ',' &&!inQuotes) {
      result.push(current); current = '';
    } else current += char;
  }
  result.push(current); return result;
}
function escapeXml(str) { return str.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
function getMimeType(url) { const ext = url.split('.').pop().toLowerCase().split('?')[0]; return { txt: 'text/plain', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.ebook' }[ext] || 'application/epub+zip'; }
function md5(str) { let hash = 0; for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; } return Math.abs(hash).toString(16); }
