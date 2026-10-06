// Proxy to the Figma REST API (the browser cannot call it directly because of CORS).
// GET /api/figma?path=/v1/files/KEY/nodes?ids=…   (header X-Figma-Token is forwarded)
// GET /api/figma?asset=https://…                   (pre-signed Figma image URL)

const ASSET_HOSTS = [/\.figma\.com$/, /\.amazonaws\.com$/, /(^|\.)figmausercontent\.com$/];

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (req) => {
  if (req.method !== "GET") return json(405, { err: "Method not allowed" });
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const asset = url.searchParams.get("asset");

  if (path) {
    if (!/^\/v1\/(files|images)\/[A-Za-z0-9]+/.test(path)) return json(400, { err: "Nepovolená cesta" });
    const token = req.headers.get("x-figma-token");
    if (!token) return json(401, { err: "Chybí X-Figma-Token" });
    const r = await fetch(`https://api.figma.com${path}`, { headers: { "X-Figma-Token": token } });
    const headers = { "content-type": r.headers.get("content-type") || "application/json" };
    const ra = r.headers.get("retry-after");
    if (ra) headers["retry-after"] = ra;
    return new Response(r.body, { status: r.status, headers });
  }

  if (asset) {
    let target;
    try { target = new URL(asset); } catch { return json(400, { err: "Neplatná URL" }); }
    if (target.protocol !== "https:" || !ASSET_HOSTS.some((re) => re.test(target.hostname))) {
      return json(400, { err: "Nepovolený host" });
    }
    const r = await fetch(target);
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" },
    });
  }
  return json(400, { err: "Chybí parametr path nebo asset" });
};

export const config = { path: "/api/figma" };
