export interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
    // 1. Rate limit check - basic IP check
//  const ip = request.headers.get('CF-Connecting-IP')
  
  // 2. Optional API key
//  const key = new URL(request.url).searchParams.get('key')
//  if (key !== env.API_KEY) return new Response("Unauthorized", { status: 401 })

  // 3. Block expensive queries
//  const url = new URL(request.url)
//  if (url.searchParams.get('q')?.length < 3) {
//    return new Response("Search must be 3+ chars", { status: 400 })
//  }
  
  const url = new URL(request.url)
  const strongs = url.searchParams.get('strongs') // H2020
  const book = url.searchParams.get('book') // 1 for GEN, 43 for JHN
  const chapter = url.searchParams.get('chapter') 
  const verse = url.searchParams.get('verse')
  const word_id = url.searchParams.get('word_id')

  try {
    // 1. STRONGS SEARCH: /api/bible?strongs=H2020
    if (strongs) {
      const query = env.DB.prepare(`
        SELECT bw.book, bw.chapter, bw.verse, bw.word, bw.transliteration, 
               s.strongs, s.lemma, s.definition, s.pos
        FROM bible_words bw
        JOIN strongs s ON bw.strongs = s.strongs
        WHERE s.strongs = ?
        ORDER BY bw.book, bw.chapter, bw.verse, bw.word
        LIMIT 200
      `).bind(strongs.toUpperCase())
      const { results } = await query.all()
      return json(results)

    // 2. SPECIFIC VERSE INTERLINEAR: /api/bible?book=1&chapter=1&verse=1
    } else if (book && chapter && verse) {
      const query = env.DB.prepare(`
        SELECT bw.word, bw.text, bw.transliteration, bw.strongs, 
               s.lemma, s.definition, m.code as morphology
        FROM bible_words bw
        LEFT JOIN strongs s ON bw.strongs = s.strongs
        LEFT JOIN morphology m ON bw.morphology = m.code
        WHERE bw.book = ? AND bw.chapter = ? AND bw.verse = ?
        ORDER BY bw.word
      `).bind(Number(book), Number(chapter), Number(verse))
      const { results } = await query.all()
      return json(results)

    // 3. WHOLE CHAPTER: /api/bible?book=1&chapter=1
    } else if (book && chapter) {
      const query = env.DB.prepare(`
        SELECT b.chapter, b.verse, b.text as verse_text,
               GROUP_CONCAT(bw.word || ':' || bw.text, ' | ') as interlinear
        FROM bible b
        LEFT JOIN bible_words bw ON b.book = bw.book AND b.chapter = bw.chapter AND b.verse = bw.verse
        WHERE b.book = ? AND b.chapter = ?
        GROUP BY b.book, b.chapter, b.verse
        ORDER BY b.verse
      `).bind(Number(book), Number(chapter))
      const { results } = await query.all()
      return json(results)

    // 4. SEARCH BY WORD: /api/bible?q=Elohim
    } else if (url.searchParams.get('q')) {
      const q = `%${url.searchParams.get('q')}%`
      const query = env.DB.prepare(`
        SELECT bw.book, bw.chapter, bw.verse, bw.word, bw.text, bw.transliteration
        FROM bible_words bw
        WHERE bw.text LIKE ? OR bw.transliteration LIKE ?
        LIMIT 100
      `).bind(q, q)
      const { results } = await query.all()
      return json(results)
    }

    return new Response(JSON.stringify({ error: "Use ?strongs= or ?book=&chapter=&verse=" }), { status: 400 })

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 })
  }
}

function json(data: any) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000" // 1 year cache, bible is static
    },
  })
}
