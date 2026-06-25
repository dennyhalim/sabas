import { onRequest as doh_slamat_link } from "./_doh_slamat_link.js";
import { onRequest as defaultPage } from "./_default.js";

export async function onRequest(context) {
  const host = context.request.headers.get("host") || "";

  const safeName = host
    .replace(/^www\./, "")
    .replace(/\./g, "_");

  const handlers = {
    doh_slamat_link
  };

  const fn = handlers[safeName] || defaultPage;

  return fn(context);
}
