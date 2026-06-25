export async function onRequest(context) {
  const { request } = context;
  const host = request.headers.get('host').replace('www.', '');

  // Try to load /functions/bio.[host].js
  const funcPath = `./${host}.js`;

  try {
    const mod = await import(funcPath);
    return mod.onRequest(context);
  } catch (e) {
    // File not found = fall back to default
    const defaultMod = await import('./default.js');
    return defaultMod.onRequest(context);
  }
}
