export async function onRequest(context) {
  const { request, next } = context;

  const url = new URL(request.url);

  // avoid recursion
  if (url.pathname.startsWith('/bio_')) {
    return next();
  }

  let host = request.headers.get('host') || '';
  host = host.replace(/^www\./, '');

  const safeName = host.replace(/\./g, '_');

  const target = `/${safeName}`;

  // try matching function route
  const rewrite = new URL(target, request.url);

  const response = await fetch(rewrite, request);

  if (response.status !== 404) {
    return response;
  }

  return fetch(new URL('/default', request.url), request);
}
