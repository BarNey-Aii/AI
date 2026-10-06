import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Converter } from "../../web/lib/converter.js";
import { findSlideNodes, parseFigmaUrl } from "../../web/lib/figma.js";
import { buildPptx } from "../../web/lib/pptx.js";
import { linearGradientXml } from "../../web/lib/paint.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const root = join(here, "..", "..");

class LocalAssets {
  async imageFill(ref) {
    const f = readdirSync(join(fixtures, "images")).find((n) => n.startsWith(`${ref}.`));
    return f ? new Uint8Array(readFileSync(join(fixtures, "images", f))) : null;
  }
  canRender() { return false; }
}

async function convertFixture(options = {}) {
  const data = JSON.parse(readFileSync(join(fixtures, "sample_slide.json"), "utf8"));
  const slides = Object.values(data.nodes).flatMap((e) => findSlideNodes(e.document));
  const result = await new Converter(new LocalAssets(), options).convert(slides);
  const buf = await buildPptx(JSZip, readFileSync(join(root, "web", "template.pptx")), result, "nodebuffer");
  return { result, buf };
}

test("parses figma links", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC/X?node-id=12-34"), { fileKey: "AbC", nodeIds: ["12:34"] });
  assert.equal(parseFigmaUrl("https://figma.com/design/MAIN/branch/BR1/X").fileKey, "BR1");
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/slides/K/D?node-id=1%3A2").nodeIds, ["1:2"]);
  assert.throws(() => parseFigmaUrl("https://example.com"));
});

test("linear gradient remaps partial handles", () => {
  const paint = { type: "GRADIENT_LINEAR",
    gradientHandlePositions: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, { x: 0.25, y: 1 }],
    gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] };
  const xml = linearGradientXml(paint, 400, 100, [0, 0, 400, 100], 1);
  assert.match(xml, /pos="25000"/);
  assert.match(xml, /pos="75000"/);
  assert.match(xml, /ang="0"/);
});

test("fixture converts to a valid package", async () => {
  const { buf } = await convertFixture();
  if (process.env.OUT) writeFileSync(process.env.OUT, buf);
  const zip = await JSZip.loadAsync(buf);
  const slide = await zip.file("ppt/slides/slide1.xml").async("string");
  const pres = await zip.file("ppt/presentation.xml").async("string");
  const types = await zip.file("[Content_Types].xml").async("string");
  assert.match(pres, /<p:sldSz cx="18288000" cy="10287000"\/>/);
  assert.match(pres, /<p:sldIdLst><p:sldId id="256"/);
  assert.match(types, /slides\/slide1\.xml/);
  assert.match(types, /Extension="png"/);
  for (const s of ["<p:bg>", "a:gradFill", "a:custGeom", "a:outerShdw", "světe", "a:blipFill"]) assert.ok(slide.includes(s), s);
  assert.ok(Object.keys(zip.files).some((n) => n.startsWith("ppt/media/")));
});

test("slide width option scales", async () => {
  const { result } = await convertFixture({ slideWidthIn: 10, rasterizeGradients: true });
  assert.equal(result.widthEmu, 9144000);
  assert.ok(result.slides[0].shapesXml.includes("a:blipFill"));
});

test("fidelity mode renders blurs, masks and clipped overflow as pictures", async () => {
  const bb = (x, y, w, h) => ({ x, y, width: w, height: h });
  const rect = (id, x, y, w, h, extra = {}) => ({ id, name: id, type: "RECTANGLE", size: { x: w, y: h },
    relativeTransform: [[1, 0, x], [0, 1, y]], absoluteBoundingBox: bb(x, y, w, h),
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], ...extra });
  const slide = { id: "s", name: "s", type: "SLIDE", size: { x: 1920, y: 1080 }, absoluteBoundingBox: bb(0, 0, 1920, 1080),
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: [
      rect("blur", 0, 0, 100, 100, { effects: [{ type: "LAYER_BLUR", radius: 8, visible: true }] }),
      { id: "clip", name: "clip", type: "FRAME", clipsContent: true, size: { x: 200, y: 200 },
        relativeTransform: [[1, 0, 300], [0, 1, 0]], absoluteBoundingBox: bb(300, 0, 200, 200),
        children: [rect("over", 250, 150, 100, 100)] },
      { id: "masked", name: "masked", type: "GROUP", size: { x: 100, y: 100 }, relativeTransform: [[1, 0, 600], [0, 1, 0]],
        absoluteBoundingBox: bb(600, 0, 100, 100), children: [rect("m", 600, 0, 100, 100, { isMask: true }), rect("x", 600, 0, 100, 100)] },
      rect("plain", 800, 0, 100, 100),
    ] };
  const asked = [];
  const assets = { imageFill: async () => null, canRender: () => true,
    renderNodes: async (ids) => { asked.push(...ids); return new Map(ids.map((i) => [i, readFileSync(join(fixtures, "images", "img1.png"))])); } };
  const res = await new Converter(assets, {}).convert([slide]);
  assert.deepEqual(asked.sort(), ["blur", "clip", "masked"]);
  assert.equal((res.slides[0].shapesXml.match(/<p:pic>/g) || []).length, 3);
  assert.ok(res.slides[0].shapesXml.includes('name="plain"'));

  asked.length = 0;
  await new Converter(assets, { fidelity: false }).convert([slide]);
  assert.deepEqual(asked, ["masked"]);

  asked.length = 0;
  const img = await new Converter(assets, { slideImages: true }).convert([slide]);
  assert.deepEqual(asked, ["s"]);
  assert.equal(img.slides[0].bgXml, "");
});
