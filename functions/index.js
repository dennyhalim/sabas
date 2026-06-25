const routes = {
  doh_slamat_link: () => import("./_doh_slamat_link.js"),
};

export async function onRequest(context) {
  const host = context.request.headers.get("host") || "";

  const safeName = host
    .replace(/^www\./, "")
    .replace(/\./g, "_");

  const loader = routes[safeName] || (() => import("./_default.js"));

  const mod = await loader();

  return mod.onRequest(context);
}
