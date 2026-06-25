import { verifyAdmin, unauthorized, json } from '../_auth.js';

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields, escaped quotes)
// ---------------------------------------------------------------------------
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map(h =>
    h.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  );
  return lines
    .slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
    });
}

// ---------------------------------------------------------------------------
// Flexible column name mapping
// ---------------------------------------------------------------------------
const FIELD_ALIASES = {
  title:       ['title', 'book_title', 'name', 'book_name'],
  author:      ['author', 'authors', 'writer', 'by', 'creator'],
  url:         ['url', 'link', 'download_url', 'book_url', 'download_link', 'file_url', 'href', 'source'],
  cover_url:   ['cover', 'cover_url', 'thumbnail', 'image', 'image_url', 'cover_image', 'thumb'],
  description: ['description', 'desc', 'summary', 'synopsis', 'about', 'blurb'],
  format:      ['format', 'type', 'file_type', 'ext', 'extension'],
  filesize:    ['size', 'filesize', 'file_size', 'bytes', 'file_bytes'],
  language:    ['language', 'lang'],
  publisher:   ['publisher', 'pub', 'published_by'],
  year:        ['year', 'published', 'pub_year', 'publication_year', 'date'],
  isbn:        ['isbn', 'isbn13', 'isbn10', 'isbn_13', 'isbn_10'],
  categories:  ['categories', 'category', 'genre', 'genres', 'tags', 'subject', 'subjects'],
};

function mapRow(rawRow, availableKeys) {
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (availableKeys.includes(alias) && rawRow[alias]) {
        out[field] = rawRow[alias];
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!await verifyAdmin(request, env)) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { source_url, mode = 'upsert' } = body; // mode: 'upsert' | 'replace'
  if (!source_url) return json({ error: 'source_url required' }, 400);

  // Fetch remote CSV
  let csvText;
  try {
    const resp = await fetch(source_url, {
      headers: { 'User-Agent': 'Books-Library-Importer/1.0' },
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    csvText = await resp.text();
  } catch (e) {
    return json({ error: `Failed to fetch CSV: ${e.message}` }, 400);
  }

  const rows = parseCSV(csvText);
  if (!rows.length) return json({ error: 'CSV is empty or has no data rows' }, 400);

  const csvKeys = Object.keys(rows[0]);

  // Replace mode: delete all rows from this source first
  if (mode === 'replace') {
    await env.BOOKS_DB.prepare('DELETE FROM books WHERE source_file = ?')
      .bind(source_url).run();
  }

  let inserted = 0, skipped = 0, batchErrors = 0;
  const BATCH = 50;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const stmts = [];

    for (const raw of chunk) {
      const row = mapRow(raw, csvKeys);
      if (!row.url || !row.title) { skipped++; continue; }

      stmts.push(
        env.BOOKS_DB.prepare(`
          INSERT INTO books
            (title,author,url,cover_url,description,format,filesize,language,publisher,year,isbn,categories,source_file)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(url) DO UPDATE SET
            title=excluded.title, author=excluded.author, cover_url=excluded.cover_url,
            description=excluded.description, format=excluded.format,
            filesize=excluded.filesize, language=excluded.language,
            publisher=excluded.publisher, year=excluded.year,
            isbn=excluded.isbn, categories=excluded.categories,
            source_file=excluded.source_file, imported_at=datetime('now')
        `).bind(
          row.title,
          row.author   || null,
          row.url,
          row.cover_url || null,
          row.description || null,
          row.format   || null,
          row.filesize  ? (parseInt(row.filesize) || null) : null,
          row.language || 'en',
          row.publisher || null,
          row.year     || null,
          row.isbn     || null,
          row.categories || null,
          source_url
        )
      );
      inserted++;
    }

    if (stmts.length) {
      try {
        await env.BOOKS_DB.batch(stmts);
      } catch {
        batchErrors += stmts.length;
        inserted -= stmts.length;
      }
    }
  }

  // Update source metadata
  const bookCount = (await env.BOOKS_DB.prepare(
    'SELECT COUNT(*) as c FROM books WHERE source_file = ?'
  ).bind(source_url).first())?.c ?? 0;

  await env.BOOKS_DB.prepare(`
    UPDATE csv_sources SET last_imported=datetime('now'), book_count=? WHERE url=?
  `).bind(bookCount, source_url).run();

  return json({
    ok: true,
    total_rows: rows.length,
    inserted,
    skipped,
    errors: batchErrors,
    book_count_in_db: bookCount,
  });
}
