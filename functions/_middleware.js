export async function onRequest(context) {
  const { request } = context;
  const host = request.headers.get('host').replace('www.', '');
  
  // Convert bio.john.com → bio_john_com
  const safeName = host.replace(/\./g, '_');
  const funcPath = `/${safeName}.js`;
  
  const res = await fetch(new URL(funcPath, new URL(request.url).origin), request);
  
  if (res.status === 404) {
    return fetch(new URL('/default.js', request.url), request);
  }
  return res;
}
