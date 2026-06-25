export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const host = request.headers.get('host').replace('www.', '');

  // Build path: /bio.john.com.js
  const funcPath = `/${host}.js`;
  const targetUrl = new URL(funcPath, url.origin);

  // Try fetch the file. If 404, go to default
  const res = await fetch(targetUrl, request);
  
  if (res.status === 404) {
    const defaultUrl = new URL('/default.js', url.origin);
    return fetch(defaultUrl, request);
  }
  
  return res;
}
