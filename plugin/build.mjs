// Builds plugin/dist/code.js and a single-file plugin/dist/ui.html (no network needed at runtime).
import { build } from "esbuild";
import JSZip from "jszip";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

const tpl = readFileSync(join(here, "..", "web", "template.pptx")).toString("base64");
writeFileSync(join(here, "src", "template.b64.js"), `export default "${tpl}";\n`);

await build({ entryPoints: [join(here, "src", "code.js")], bundle: true, outfile: join(dist, "code.js"),
  target: "es2017", format: "iife", logLevel: "warning" });
const ui = await build({ entryPoints: [join(here, "src", "ui.js")], bundle: true, write: false,
  target: "es2020", format: "iife", minify: true, logLevel: "warning" });
const js = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(join(here, "src", "ui.html"), "utf8").replace("/*__UI_JS__*/", () => js);
writeFileSync(join(dist, "ui.html"), html);
console.log("plugin/dist built:", Math.round(html.length / 1024), "KB ui.html");

const zip = new JSZip();
const dir = zip.folder("figma2pptx-plugin");
dir.file("manifest.json", readFileSync(join(here, "manifest.json")));
dir.file("dist/code.js", readFileSync(join(dist, "code.js")));
dir.file("dist/ui.html", html);
writeFileSync(join(here, "..", "web", "figma2pptx-plugin.zip"),
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log("web/figma2pptx-plugin.zip written");
