// Figma link parsing, API access (through the Netlify proxy) and slide discovery.

const URL_RE = /figma\.com\/(?:file|design|slides|deck|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/;

export function parseFigmaUrl(url) {
  const m = URL_RE.exec((url || "").trim());
  if (!m) throw new Error("Neplatný Figma odkaz. Očekávám např. https://www.figma.com/design/<KEY>/Nazev?node-id=1-2");
  const fileKey = m[2] || m[1];
  let nodeIds = [];
  try {
    const q = new URL(url.trim()).searchParams.get("node-id");
    if (q) nodeIds = q.split(",").map((s) => s.trim().replace(/-/g, ":")).filter(Boolean);
  } catch { /* ignore */ }
  return { fileKey, nodeIds };
}

export class FigmaClient {
  // proxyBase: "/api/figma" on Netlify; null = call api.figma.com directly.
  constructor(token, proxyBase = "/api/figma", fetchImpl = globalThis.fetch.bind(globalThis)) {
    if (!token) throw new Error("Chybí Figma Personal Access Token.");
    this.token = token;
    this.proxy = proxyBase;
    this.fetch = fetchImpl;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const apiPath = `/v1${path}${qs ? `?${qs}` : ""}`;
    const url = this.proxy ? `${this.proxy}?path=${encodeURIComponent(apiPath)}` : `https://api.figma.com${apiPath}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await this.fetch(url, { headers: { "X-Figma-Token": this.token } });
      if (resp.status === 429) {
        const wait = Math.min(60, +(resp.headers.get("Retry-After") || 2 ** attempt));
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (resp.status === 403) throw new Error("Figma API vrátilo 403 – token je neplatný nebo nemá přístup k souboru (scope File content: Read).");
      if (resp.status === 404) throw new Error("Figma soubor nebo uzel nebyl nalezen (404).");
      const text = await resp.text();
      if (resp.status === 400 && /File type not supported/i.test(text)) {
        throw new Error("Tento odkaz vede na soubor Figma Slides. Figma API soubory Slides nepodporuje – " +
          "použijte plugin „Figma → PPTX“ (ke stažení níže), který převede snímky přímo ve Figmě.");
      }
      if (!resp.ok) throw new Error(`Figma API chyba ${resp.status}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      if (data.err) throw new Error(`Figma API chyba: ${data.err}`);
      return data;
    }
    throw new Error("Figma API: překročen limit požadavků (429).");
  }

  async getFile(fileKey) {
    return this.get(`/files/${fileKey}`, { geometry: "paths" });
  }

  async getNodes(fileKey, ids) {
    const data = await this.get(`/files/${fileKey}/nodes`, { ids: ids.join(","), geometry: "paths" });
    const out = {};
    for (const [id, entry] of Object.entries(data.nodes || {})) {
      if (!entry) throw new Error(`Uzel ${id} nebyl v souboru nalezen.`);
      out[id] = entry.document;
    }
    return out;
  }

  async imageFillUrls(fileKey) {
    const data = await this.get(`/files/${fileKey}/images`);
    return data.meta?.images || {};
  }

  async renderUrls(fileKey, ids, scale = 2) {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.get(`/images/${fileKey}`, {
        ids: ids.slice(i, i + 50).join(","), format: "png", scale, use_absolute_bounds: "true",
      });
      for (const [k, v] of Object.entries(data.images || {})) if (v) out[k] = v;
    }
    return out;
  }

  async download(url) {
    // Try direct first (S3 links are pre-signed), then go through the proxy.
    try {
      const r = await this.fetch(url);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch { /* CORS or network – fall back to proxy */ }
    if (!this.proxy) throw new Error(`Stažení selhalo: ${url}`);
    const r = await this.fetch(`${this.proxy}?asset=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error(`Stažení selhalo (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }
}

export class FigmaAssets {
  constructor(client, fileKey) {
    this.client = client;
    this.fileKey = fileKey;
    this.fillUrls = null;
  }
  async imageFill(ref) {
    if (!this.fillUrls) this.fillUrls = await this.client.imageFillUrls(this.fileKey);
    const url = this.fillUrls[ref];
    return url ? this.client.download(url) : null;
  }
  canRender() { return true; }
  async renderNodes(ids) {
    const urls = await this.client.renderUrls(this.fileKey, ids);
    const out = new Map();
    for (const [id, url] of Object.entries(urls)) out.set(id, await this.client.download(url));
    return out;
  }
}

// Nodes that become slides, starting from root.
export function findSlideNodes(root, allPages = false) {
  const slides = [];
  const collect = (n) => {
    if (n.type === "SLIDE") { if (n.visible !== false) slides.push(n); return; }
    for (const c of n.children || []) collect(c);
  };
  collect(root);
  if (slides.length) return slides;
  const frameTypes = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP"]);
  const framesOf = (container) => {
    const out = [];
    for (const c of container.children || []) {
      if (c.visible === false) continue;
      if (c.type === "SECTION") out.push(...framesOf(c));
      else if (frameTypes.has(c.type)) out.push(c);
    }
    return out;
  };
  if (root.type === "DOCUMENT") {
    let pages = root.children || [];
    if (!allPages) pages = pages.slice(0, 1);
    for (const p of pages) slides.push(...framesOf(p));
    return slides;
  }
  if (root.type === "CANVAS" || root.type === "SECTION") return framesOf(root);
  return [root];
}

// High level: link -> {slides nodes, assets}
export async function loadFromFigma(url, token, { allPages = false, proxyBase = "/api/figma", onProgress = () => {} } = {}) {
  const link = parseFigmaUrl(url);
  const client = new FigmaClient(token, proxyBase);
  onProgress("Načítám data z Figmy…");
  let slides = [];
  if (link.nodeIds.length) {
    const nodes = await client.getNodes(link.fileKey, link.nodeIds);
    for (const id of link.nodeIds) slides.push(...findSlideNodes(nodes[id], allPages));
  } else {
    const file = await client.getFile(link.fileKey);
    slides = findSlideNodes(file.document, allPages);
  }
  return { slides, assets: new FigmaAssets(client, link.fileKey) };
}
