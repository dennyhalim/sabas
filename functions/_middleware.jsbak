export async function onRequest(context) {
  const { request, next } = context;

  const url = new URL(request.url);

  if (url.pathname.startsWith('/')) {
    return next();
  }

  let host = (request.headers.get('host') || '')
    .replace(/^www\./, '');

  const target = `/bio_${host.replace(/\./g, '_')}`;

  url.pathname = target;

  let res = await context.next(new Request(url, request));

  if (res.status === 404) {
    url.pathname = '/default';
    res = await context.next(new Request(url, request));
  }

  return res;
}
