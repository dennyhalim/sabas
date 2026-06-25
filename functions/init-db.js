import { verifyAdmin, unauthorized, json } from '../_auth.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    author      TEXT,
    url         TEXT NOT NULL,
    cover_url   TEXT,
    description TEXT,
    format      TEXT,
    filesize    INTEGER,
    language    TEXT DEFAULT 'en',
    publisher   TEXT,
    year        TEXT,
    isbn        TEXT,
    categories  TEXT,
    source_file TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_books_url    ON books(url)`,
  `CREATE INDEX IF NOT EXISTS idx_books_title         ON books(title COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_books_author        ON books(author COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_books_format        ON books(format)`,
  `CREATE INDEX IF NOT EXISTS idx_books_language      ON books(language)`,
  `CREATE INDEX IF NOT EXISTS idx_books_source        ON books(source_file)`,
  `CREATE TABLE IF NOT EXISTS csv_sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT,
    url           TEXT UNIQUE NOT NULL,
    last_imported TEXT,
    book_count    INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  )`,
];

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!await verifyAdmin(request, env)) return unauthorized();

  const results = [];
  for (const stmt of DDL) {
    try {
      await env.BOOKS_DB.exec(stmt);
      results.push({ ok: true, stmt: stmt.slice(0, 60) + '…' });
    } catch (e) {
      results.push({ ok: false, stmt: stmt.slice(0, 60) + '…', error: e.message });
    }
  }

  const failed = results.filter(r => !r.ok);
  return json({ ok: failed.length === 0, results, failed: failed.length });
}
