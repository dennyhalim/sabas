/**
 * Cloudflare Pages Function — Linktree
 * File: functions/index.js
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 * 1. Deploy to Cloudflare Pages
 * 2. Create a KV namespace called BLOCKED_IPS in Workers & Pages → KV
 * 3. Bind it: Pages project → Settings → Functions → KV namespace bindings
 *    Variable name: BLOCKED_IPS
 * 4. Set environment variables (Settings → Environment variables):
 *    TG_BOT_TOKEN   — from @BotFather
 *    TG_CHAT_ID     — from @userinfobot
 * 5. All other config lives below in the CONFIG section
 * ──────────────────────────────────────────────────────────────────────────
 */

// ─── CONFIG (safe to commit — no secrets here) ───────────────────────────────

const CONFIG = {
  title:    'Bagaimana Saya Diselamatkan',
  bio:      'Beri Dirimu Diselamatkan',
  avatar:   '',   // full https:// URL or '' for initials

  links: [
    { label: 'Website',    url: 'https://matikemana.com',           icon: '🌐' },
    { label: 'Facebook',     url: 'https://facebook.com/alkitabsaja',   icon: '🐙' },
    { label: 'Instagram',   url: 'https://instagram.com/alkitabsaja',  icon: '🐘' },
    { label: 'Telegram', url: 'https://t.me/addlist/Qt557gGoAsIwZDI1',icon: '📬' },
    { label: 'Tiktok',     url: 'https://www.tiktok.com/@rantovaber/',   icon: '🐙' },
  ],

  rss: {
    url:      'https://sabas.pages.dev/?format=rss',  // '' to disable
    max:      30,
    label:    'Latest posts',
    cacheTtl: 18000,  // seconds
  },

  youtube: {
    playlistId: 'PLWkdf0BXgzp9IFxua1ITVjqr_xHGO-KUw',   // e.g. 'PLxxxxxxxx' or '' to disable
    label:      'My Playlist',
  },

  contact: {
    enabled:    false,
    maxLen:     1000,
  },

  honeypot: {
    minFormSec: 3,      // reject if submitted faster than this
  },
};

// ─────────────────────────────────────────────────────────────────────────────

// ── Security helpers ──────────────────────────────────────────────────────────

function safeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : '#';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

// ── IP blocking via KV ────────────────────────────────────────────────────────

async function isBlocked(env, ip) {
  if (!env.BLOCKED_IPS) return false;
  const val = await env.BLOCKED_IPS.get(ip);
  return val !== null;
}

async function blockIp(env, ip, reason) {
  if (!env.BLOCKED_IPS) return;
  await env.BLOCKED_IPS.put(ip, JSON.stringify({
    reason,
    time: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30-day block
}

// ── Telegram ──────────────────────────────────────────────────────────────────
// Token comes from env — never in code, never in HTML output.

async function tgSend(env, text) {
  const token  = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {}); // fire-and-forget, don't fail the request
}

// ── RSS fetching via Cache API ────────────────────────────────────────────────

async function fetchRss() {
  const { url, max, cacheTtl } = CONFIG.rss;
  if (!url) return [];

  const cacheKey = new Request(`https://rss-cache/${btoa(url)}`);
  const cache    = caches.default;
  let   raw      = null;

  // Try cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    raw = await cached.text();
  } else {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Linktree/1.0' },
      cf: { cacheTtl },
    }).catch(() => null);
    if (!res?.ok) return [];
    raw = await res.text();
    // Store in cache
    await cache.put(cacheKey, new Response(raw, {
      headers: { 'Cache-Control': `max-age=${cacheTtl}` },
    }));
  }

  // Parse XML — Workers don't have DOMParser but HTMLRewriter can parse XML
  // Use a lightweight regex approach for RSS/Atom
  const items = [];

  // Try RSS 2.0 <item> blocks first, then Atom <entry>
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let   match;

  while ((match = itemRegex.exec(raw)) !== null && items.length < max) {
    const block = match[1];

    // Title
    const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim()
      : '';

    // Link — prefer rel="alternate" for Atom
    let link = '';
    const altMatch = block.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i)
                  || block.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["']/i);
    if (altMatch) {
      link = altMatch[1];
    } else {
      const linkMatch = block.match(/<link[^>]*>([^<]+)<\/link>/i)
                     || block.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = linkMatch?.[1]?.trim() ?? '';
    }

    if (title && link && /^https?:\/\//i.test(link)) {
      items.push({ label: title, url: link });
    }
  }

  return items;
}

// ── Honeypot check ────────────────────────────────────────────────────────────

async function checkHoneypot(env, ip, formData, request) {
  let triggered = false;
  let reason    = '';

  if (formData.get('website') !== '') {
    triggered = true;
    reason    = 'honeypot field filled';
  }

  const formTime = parseInt(formData.get('form_time') || '0', 10);
  const now      = Math.floor(Date.now() / 1000);
  if (!triggered && formTime > 0 && (now - formTime) < CONFIG.honeypot.minFormSec) {
    triggered = true;
    reason    = `form submitted too fast (${now - formTime}s)`;
  }

  if (!triggered) return false;

  // Block IP and log — no tarpit, instant fake success to save free tier quota
  await blockIp(env, ip, reason);

  // Log to Telegram
  const ua  = (request.headers.get('User-Agent') || 'unknown').slice(0, 200);
  await tgSend(env,
    `🚨 <b>Honeypot triggered</b>\n` +
    `IP: <code>${escHtml(ip)}</code>\n` +
    `Reason: ${escHtml(reason)}\n` +
    `UA: ${escHtml(ua)}\n` +
    `Time: ${new Date().toISOString()}`
  );

  return true; // was triggered
}

// ── Contact form handler ──────────────────────────────────────────────────────

async function handlePost(request, env) {
  const ip = getClientIp(request);

  if (await isBlocked(env, ip)) {
    return new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Bad request' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Honeypot
  const trapped = await checkHoneypot(env, ip, formData, request);
  if (trapped) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate
  const name    = (formData.get('name')    || '').trim().replace(/<[^>]+>/g, '');
  const email   = (formData.get('email')   || '').trim();
  const phone   = (formData.get('phone')   || '').trim().replace(/<[^>]+>/g, '');
  const message = (formData.get('message') || '').trim().replace(/<[^>]+>/g, '');
  const errors  = [];

  if (!name || name.length > 100)
    errors.push('Name is required (max 100 chars).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
    errors.push('A valid email address is required.');
  if (phone && !/^[+\d\s\-().]{5,30}$/.test(phone))
    errors.push('Phone number format is invalid.');
  if (!message)
    errors.push('Message cannot be empty.');
  if (message.length > CONFIG.contact.maxLen)
    errors.push(`Message is too long (max ${CONFIG.contact.maxLen} chars).`);

  if (errors.length) {
    return new Response(JSON.stringify({ ok: false, error: errors.join(' ') }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await tgSend(env,
    `📩 <b>New contact message</b>\n` +
    `From: <b>${escHtml(name)}</b> &lt;${escHtml(email)}&gt;\n` +
    (phone ? `Phone: ${escHtml(phone)}\n` : '') +
    `IP: <code>${escHtml(ip)}</code>\n` +
    `Time: ${new Date().toISOString()}\n\n` +
    escHtml(message)
  );

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function renderLinks(links, cssClass = '') {
  return links.map(({ label, url, icon }) => `
    <a class="link-item ${cssClass}" href="${escHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">
      <span class="link-icon">${icon ?? '📝'}</span>
      <span class="link-label">${escHtml(label)}</span>
      <span class="link-arrow">›</span>
    </a>`).join('');
}

function renderHtml(rssLinks) {
  const { title, bio, avatar, links, youtube, contact } = CONFIG;
  const initials = title.split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const ytId     = youtube.playlistId.replace(/[^a-zA-Z0-9_-]/g, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&display=swap');
  :root{--bg:#0d0d0f;--surface:#18181c;--border:#2a2a30;--accent:#e8c547;--accent2:#7c6af7;--text:#e8e8ec;--muted:#666672;--radius:12px}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:3rem 1.25rem 4rem}
  body::before{content:'';position:fixed;top:-10vh;left:50%;transform:translateX(-50%);width:600px;height:400px;background:radial-gradient(ellipse,#7c6af720 0%,transparent 70%);pointer-events:none;z-index:0}
  .card{position:relative;z-index:1;width:100%;max-width:480px;display:flex;flex-direction:column;gap:2rem}
  .profile{display:flex;flex-direction:column;align-items:center;gap:.75rem;text-align:center}
  .avatar{width:80px;height:80px;border-radius:50%;border:2px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;font-family:'DM Serif Display',serif;font-size:1.6rem;color:var(--accent);overflow:hidden;flex-shrink:0}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .profile h1{font-family:'DM Serif Display',serif;font-size:1.6rem;font-weight:400;letter-spacing:-.01em;color:var(--text)}
  .profile p{font-size:.78rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
  section{display:flex;flex-direction:column;gap:.6rem}
  .section-label{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);padding:0 .25rem;margin-bottom:.1rem}
  .link-item{display:flex;align-items:center;gap:.85rem;padding:.85rem 1.1rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);text-decoration:none;color:var(--text);font-size:.85rem;transition:border-color .18s,background .18s,transform .15s;position:relative;overflow:hidden}
  .link-item::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,var(--accent2) 0%,transparent 100%);opacity:0;transition:opacity .2s}
  .link-item:hover{border-color:var(--accent2);transform:translateX(3px)}
  .link-item:hover::after{opacity:.06}
  .link-icon{font-size:1.1rem;flex-shrink:0;width:1.5rem;text-align:center;position:relative;z-index:1}
  .link-label{flex:1;position:relative;z-index:1}
  .link-arrow{color:var(--muted);font-size:.7rem;position:relative;z-index:1;transition:color .18s,transform .18s}
  .link-item:hover .link-arrow{color:var(--accent);transform:translateX(2px)}
  .link-item.rss-item:hover{border-color:var(--accent)}
  .link-item.rss-item::after{background:linear-gradient(90deg,var(--accent) 0%,transparent 100%)}
  .yt-wrap{border-radius:var(--radius);overflow:hidden;border:1px solid var(--border);background:#000;aspect-ratio:16/9}
  .yt-wrap iframe{width:100%;height:100%;display:block;border:none}
  footer{margin-top:1rem;font-size:.7rem;color:var(--muted);text-align:center;letter-spacing:.04em}
  .form-wrap{display:flex;flex-direction:column;gap:.75rem}
  .form-field{display:flex;flex-direction:column;gap:.35rem}
  .form-field label{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .form-field input,.form-field textarea{background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'DM Mono',monospace;font-size:.85rem;padding:.7rem .9rem;outline:none;transition:border-color .18s;resize:vertical}
  .form-field input:focus,.form-field textarea:focus{border-color:var(--accent2)}
  .form-field textarea{min-height:100px}
  .hp-field{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;opacity:0}
  .form-submit{background:var(--accent2);color:#fff;border:none;border-radius:8px;padding:.75rem 1.25rem;font-family:'DM Mono',monospace;font-size:.85rem;cursor:pointer;transition:opacity .18s,transform .15s;align-self:flex-end}
  .form-submit:hover{opacity:.85;transform:translateY(-1px)}
  .form-submit:disabled{opacity:.4;cursor:not-allowed}
  .form-msg{font-size:.8rem;padding:.6rem .9rem;border-radius:8px;display:none}
  .form-msg.ok{background:#1a3a1a;color:#7ecf7e;display:block}
  .form-msg.err{background:#3a1a1a;color:#cf7e7e;display:block}
  .card>*{opacity:0;transform:translateY(12px);animation:fadeUp .4s ease forwards}
  .card>*:nth-child(1){animation-delay:.05s}
  .card>*:nth-child(2){animation-delay:.12s}
  .card>*:nth-child(3){animation-delay:.19s}
  .card>*:nth-child(4){animation-delay:.26s}
  .card>*:nth-child(5){animation-delay:.33s}
  @keyframes fadeUp{to{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="card">

  <div class="profile">
    <div class="avatar">
      ${avatar ? `<img src="${escHtml(avatar)}" alt="${escHtml(title)}">` : escHtml(initials)}
    </div>
    <h1>${escHtml(title)}</h1>
    <p>${escHtml(bio)}</p>
  </div>

  ${links.length ? `<section>
    <div class="section-label">Links</div>
    ${renderLinks(links)}
  </section>` : ''}

  ${rssLinks.length ? `<section>
    <div class="section-label">${escHtml(CONFIG.rss.label)}</div>
    ${renderLinks(rssLinks, 'rss-item')}
  </section>` : ''}

  ${ytId ? `<section>
    <div class="section-label">${escHtml(youtube.label)}</div>
    <div class="yt-wrap">
      <iframe
        src="https://www.youtube-nocookie.com/embed/videoseries?list=${ytId}&rel=0"
        title="${escHtml(youtube.label)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen loading="lazy"></iframe>
    </div>
  </section>` : ''}

  ${contact.enabled ? `<section>
    <div class="section-label">Contact</div>
    <div class="form-wrap">
      <div id="form-msg" class="form-msg"></div>
      <div class="form-field">
        <label for="f-name">Name</label>
        <input id="f-name" type="text" maxlength="100" autocomplete="name">
      </div>
      <div class="form-field">
        <label for="f-email">Email</label>
        <input id="f-email" type="email" maxlength="200" autocomplete="email">
      </div>
      <div class="form-field">
        <label for="f-phone">Phone <span style="color:var(--muted);font-size:.7rem"></span></label>
        <input id="f-phone" type="tel" maxlength="30" autocomplete="tel">
      </div>
      <div class="form-field">
        <label for="f-msg">Message</label>
        <textarea id="f-msg" maxlength="${contact.maxLen}"></textarea>
      </div>
      <div class="hp-field" aria-hidden="true">
        <input id="f-website" type="text" tabindex="-1" autocomplete="off">
      </div>
      <input type="hidden" id="form-time" value="0">
      <button class="form-submit" id="form-btn" type="button" onclick="submitForm()">Send message</button>
    </div>
  </section>` : ''}

  <footer>${escHtml(title)}</footer>
</div>
<script>
document.getElementById('form-time').value = Math.floor(Date.now() / 1000);
async function submitForm() {
  const btn = document.getElementById('form-btn');
  const msg = document.getElementById('form-msg');
  const name = document.getElementById('f-name').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const message = document.getElementById('f-msg').value.trim();
  msg.className = 'form-msg'; msg.textContent = '';
  if (!name || !email || !message) {
    msg.className = 'form-msg err'; msg.textContent = 'Please fill in all fields.'; return;
  }
  btn.disabled = true; btn.textContent = 'Sending\u2026';
  const body = new FormData();
  body.append('name', name); body.append('email', email);
  body.append('phone', document.getElementById('f-phone').value.trim());
  body.append('message', message);
  body.append('website', document.getElementById('f-website').value ?? '');
  body.append('form_time', document.getElementById('form-time').value);
  try {
    const res = await fetch(location.pathname, { method: 'POST', body });
    const data = await res.json();
    if (data.ok) {
      msg.className = 'form-msg ok'; msg.textContent = "Message sent! I'll get back to you soon.";
      ['f-name','f-email','f-phone','f-msg'].forEach(id => document.getElementById(id).value = '');
      btn.textContent = 'Sent \u2713';
    } else {
      msg.className = 'form-msg err'; msg.textContent = data.error ?? 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Send message';
    }
  } catch {
    msg.className = 'form-msg err'; msg.textContent = 'Network error. Please try again.';
    btn.disabled = false; btn.textContent = 'Send message';
  }
}
<\/script>
<script data-goatcounter="https://diselamatkan.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>
</body>
</html>`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const ip     = getClientIp(request);

  const secHeaders = {
//    'X-Frame-Options':           'SAMEORIGIN',
    'X-Content-Type-Options':    'nosniff',
    'Referrer-Policy':           'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "img-src * data:; frame-src https://www.youtube-nocookie.com; " +
      "font-src https://fonts.gstatic.com; style-src-elem 'unsafe-inline' https://fonts.googleapis.com",
  };

  // Block on GET too
  if (await isBlocked(env, ip)) {
    return new Response('Forbidden', { status: 403, headers: secHeaders });
  }

  if (method === 'POST' && CONFIG.contact.enabled) {
    const res = await handlePost(request, env);
    Object.entries(secHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }

  // GET — fetch RSS then render
  const rssLinks = await fetchRss();
  const html     = renderHtml(rssLinks);

  return new Response(html, {
    headers: { ...secHeaders, 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
