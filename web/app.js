import { Converter } from "./lib/converter.js";
import { loadFromFigma, parseFigmaUrl } from "./lib/figma.js";
import { buildPptx } from "./lib/pptx.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "figma2pptx.token";

function store(fn) { try { return fn(); } catch { return null; } }

const saved = store(() => localStorage.getItem(TOKEN_KEY));
if (saved) { $("token").value = saved; $("remember").checked = true; }

function setStatus(text, ok = false) {
  $("status").textContent = text;
  $("status").className = ok ? "ok" : "";
}

function message(text, kind) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  $("messages").appendChild(div);
}

function fileName(url) {
  const m = /figma\.com\/[a-z]+\/[A-Za-z0-9]+\/([^/?#]+)/.exec(url);
  const name = (m ? decodeURIComponent(m[1]) : "figma").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${name || "figma"}.pptx`;
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("messages").textContent = "";
  const url = $("url").value.trim();
  const token = $("token").value.trim();
  store(() => ($("remember").checked ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY)));
  $("go").disabled = true;
  try {
    parseFigmaUrl(url);
    const { slides, assets } = await loadFromFigma(url, token, { allPages: $("allpages").checked, onProgress: setStatus });
    const conv = new Converter(assets, {
      slideWidthIn: $("width").value ? parseFloat($("width").value) : null,
      rasterizeGradients: $("raster").checked,
      fontWeights: $("weights").checked ? "names" : "bold",
    });
    const result = await conv.convert(slides, setStatus);
    setStatus("Sestavuji PPTX…");
    const template = await (await fetch("template.pptx")).arrayBuffer();
    const blob = await buildPptx(window.JSZip, template, result, "blob");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName(url);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    setStatus(`Hotovo – ${result.slides.length} ${result.slides.length === 1 ? "snímek" : "snímků"} staženo jako ${a.download}.`, true);
    if (result.warnings.length) message(`Upozornění:\n• ${result.warnings.join("\n• ")}`, "warn");
  } catch (e) {
    console.error(e);
    setStatus("");
    message(e.message || String(e), "err");
  } finally {
    $("go").disabled = false;
  }
});
