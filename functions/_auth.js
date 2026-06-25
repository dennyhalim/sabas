const TOKEN_NAME = 'admin_token';

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret || 'changeme'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function createToken(env) {
  const day = new Date().toISOString().slice(0, 10);
  return hmac(env.ADMIN_SECRET || 'changeme-secret', `${env.ADMIN_PASSWORD}:${day}`);
}

export async function verifyAdmin(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`${TOKEN_NAME}=([^;\\s]+)`));
  if (!m) return false;
  try {
    const expected = await createToken(env);
    return m[1] === expected;
  } catch {
    return false;
  }
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export function unauthorized() {
  return json({ error: 'Unauthorized' }, 401);
}
