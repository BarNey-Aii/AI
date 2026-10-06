// Plugin UI (iframe): receives the serialized tree, runs the converter and downloads the PPTX.
import JSZip from "jszip";
import { Converter } from "../../web/lib/converter.js";
import { buildPptx } from "../../web/lib/pptx.js";
import TEMPLATE_B64 from "./template.b64.js";
import { FontLibrary } from "../../web/lib/fonts.js";
import { cropImage, normalizeImage } from "../../web/lib/imageops.js";

const fontLib = new FontLibrary();
let usedFonts = [];

const $ = (id) => document.getElementById(id);
const send = (msg) => parent.postMessage({ pluginMessage: msg }, "*");
const pending = new Map();
let reqSeq = 0;
let resolveTree = null;

function request(msg) {
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    send({ ...msg, reqId });
  });
}

window.onmessage = (ev) => {
  const msg = ev.data && ev.data.pluginMessage;
  if (!msg) return;
  if (msg.type === "stored-fonts") {
    for (const f of msg.fonts) { try { fontLib.add(new Uint8Array(f.bytes), f.name); } catch { /* skip */ } }
    renderFonts();
  } else if (msg.type === "font-save-failed") {
    $("fontmsg").textContent = `Písmo „${msg.name}“ se nepodařilo uložit pro příště (${msg.message}). Pro tento export je načtené.`;
  } else if (msg.type === "info") {
    usedFonts = msg.fonts || [];
    renderFonts();
    const n = msg.count;
    const what = msg.editor === "slides" ? plural(n, "snímek", "snímky", "snímků") : plural(n, "rámec", "rámce", "rámců");
    $("info").textContent = n
      ? `${msg.fromSelection ? "Vybráno" : "Celkem"}: ${n} ${what}${msg.fromSelection ? "" : " (nic nevybráno → převedou se všechny)"}`
      : "Vyberte snímek nebo rámec.";
    $("go").disabled = !msg.count;
  } else if (msg.type === "tree" && resolveTree) {
    resolveTree(msg.slides);
    resolveTree = null;
  } else if (msg.reqId && pending.has(msg.reqId)) {
    const p = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg.bytes ? new Uint8Array(msg.bytes) : null);
  } else if (msg.type === "error") {
    showError(msg.message);
  }
};

const STYLE = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
const fontLabel = (f) => `${f.family} ${STYLE[Math.round(f.weight / 100) * 100] || f.weight}${f.italic ? " Italic" : ""}`;

function renderFonts() {
  const box = $("fonts");
  box.textContent = "";
  if (!usedFonts.length) { box.textContent = "Žádný text."; return; }
  for (const f of usedFonts) {
    const row = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = fontLabel(f);
    const st = document.createElement("span");
    if (fontLib.find(f.family, f.weight, f.italic)) { st.className = "ok-f"; st.textContent = "✓ vloží se"; }
    else {
      st.className = "miss-f";
      const a = document.createElement("a");
      a.href = `https://fonts.google.com/specimen/${encodeURIComponent(f.family).replace(/%20/g, "+")}`;
      a.target = "_blank";
      a.textContent = "chybí soubor";
      a.title = "Otevřít na Google Fonts (pokud tam písmo je)";
      st.appendChild(a);
    }
    row.append(name, st);
    box.appendChild(row);
  }
}

$("fontfiles").onchange = async (ev) => {
  const errors = [];
  for (const file of ev.target.files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = fontLib.add(bytes, file.name);
      if (info.isVariable) errors.push(`${file.name}: variabilní písmo – vloží se jen výchozí řez, použijte statické .ttf.`);
      send({ type: "font-save", key: `font:${info.fullName}|${info.italic ? 1 : 0}`, name: info.fullName, bytes });
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  $("fontmsg").textContent = errors.join("\n");
  ev.target.value = "";
  renderFonts();
};

const assets = {
  imageFill: async (hash) => normalizeImage(await request({ type: "image", hash })),
  cropImage,
  canRender: () => true,
  async renderNodes(ids) {
    const out = new Map();
    for (const id of ids) {
      const bytes = await request({ type: "render", id, scale: +$("scale").value || 2 });
      if (bytes) out.set(id, bytes);
    }
    return out;
  },
};

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
const HINTS = {
  fidelity: "Vše, co PPTX umí, je nativní a editovatelné; masky, rozmazání a ořezy se vloží jako přesný obrázek.",
  editable: "Všechno nativně; masky jako obrázek, rozmazání a ořezy se vynechají.",
  image: "Každý snímek = jeden obrázek. Vzhled 100 %, ale nic nejde upravit.",
};
$("mode").onchange = () => { $("hint").textContent = HINTS[$("mode").value]; };

function setStatus(t, ok = false) { $("status").textContent = t; $("status").className = ok ? "ok" : ""; }
function showError(t) { $("msg").className = "msg err"; $("msg").textContent = t; }
function showWarn(list) { $("msg").className = "msg warn"; $("msg").textContent = `Upozornění:\n• ${list.join("\n• ")}`; }

$("go").onclick = async () => {
  $("go").disabled = true;
  $("msg").textContent = ""; $("msg").className = "";
  try {
    setStatus("Načítám snímky…");
    const slides = await new Promise((resolve) => { resolveTree = resolve; send({ type: "collect" }); });
    const mode = $("mode").value;
    const conv = new Converter(assets, {
      slideWidthIn: $("width").value ? parseFloat($("width").value) : null,
      rasterizeGradients: $("raster").checked,
      fontWeights: $("weights").checked ? "names" : "bold",
      fidelity: mode !== "editable",
      slideImages: mode === "image",
      fonts: $("embed").checked ? fontLib : null,
    });
    fontLib.used = new Set();
    const result = await conv.convert(slides, setStatus);
    setStatus("Sestavuji PPTX…");
    const blob = await buildPptx(JSZip, b64ToBytes(TEMPLATE_B64), result, "blob");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${($("name").value || "prezentace").replace(/[\\/:*?"<>|]+/g, "-")}.pptx`;
    document.body.appendChild(a); a.click(); a.remove();
    const n = result.slides.length;
    setStatus(`Hotovo – ${n} ${plural(n, "snímek", "snímky", "snímků")} → ${a.download}`, true);
    send({ type: "notify", text: `PPTX hotové (${n} ${plural(n, "snímek", "snímky", "snímků")})` });
    const warnings = [...result.warnings];
    if ($("embed").checked && result.missingFonts.length) {
      warnings.unshift(`Nevložená písma (chybí soubor): ${result.missingFonts.map(fontLabel).join(", ")} – na počítači bez nich se nahradí.`);
    }
    if (warnings.length) showWarn(warnings);
  } catch (e) {
    console.error(e);
    setStatus("");
    showError(e.message || String(e));
  } finally {
    $("go").disabled = false;
  }
};

send({ type: "ready" });
