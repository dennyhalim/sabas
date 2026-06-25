export async function onRequest({request}) {
  const host = request.headers.get('host');
  return new Response(`Host = ${host}`, {headers:{'Content-Type':'text/plain'}});
}
