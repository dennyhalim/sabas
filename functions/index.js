import * as doh_slamat_link from "./_doh_slamat_link.js";
import * as default_js from "./_default.js";

const apps = {
  doh_slamat_link,
};

export async function onRequest(context) {
  let host = context.request.headers.get("host") || "";

  const safeName = host
    .replace(/^www\./, "")
    .replace(/\./g, "_");

  const app = apps[safeName] || default_js;

  return app.onRequest(context);
}
