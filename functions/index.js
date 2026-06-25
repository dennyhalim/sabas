export async function onRequest(context) {
  const host = context.request.headers.get("host") || "";

  const safeName = host
    .replace(/^www\./, "")
    .replace(/\./g, "_");

  let handler;

  try {
    handler = await import(`./_${safeName}.js`);
  } catch (e) {
    handler = await import("./_default.js");
  }

  return handler.onRequest(context);
}
