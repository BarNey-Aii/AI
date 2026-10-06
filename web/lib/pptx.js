// Packages converter output into a .pptx using a blank template and JSZip.

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RT_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RT_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const RT_FONT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", fntdata: "application/x-fontdata" };

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slideXml(s) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld>${s.bgXml}<p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${s.shapesXml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function relsXml(rels, layoutTarget) {
  const items = rels.map((r) => {
    if (r.type === "layout") return `<Relationship Id="${r.id}" Type="${RT_LAYOUT}" Target="${layoutTarget}"/>`;
    const mode = r.external ? ' TargetMode="External"' : "";
    return `<Relationship Id="${r.id}" Type="${r.type}" Target="${escAttr(r.target)}"${mode}/>`;
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
}

// result: output of Converter.convert(); template: ArrayBuffer/Uint8Array of web/template.pptx
export async function buildPptx(JSZip, template, result, outType = "blob") {
  const zip = await JSZip.loadAsync(template);

  // Blank layout of the template.
  let layoutTarget = "../slideLayouts/slideLayout7.xml";
  for (const path of Object.keys(zip.files)) {
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path)) {
      const xml = await zip.file(path).async("string");
      if (/<p:cSld name="Blank"/.test(xml)) { layoutTarget = `../slideLayouts/${path.split("/").pop()}`; break; }
    }
  }

  let pres = await zip.file("ppt/presentation.xml").async("string");
  let presRels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  let types = await zip.file("[Content_Types].xml").async("string");

  let maxRid = 0;
  for (const m of presRels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, +m[1]);

  const sldIds = [];
  const newRels = [];
  const overrides = [];
  result.slides.forEach((s, i) => {
    const n = i + 1;
    const rid = `rId${maxRid + n}`;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(s));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(s.rels, layoutTarget));
    sldIds.push(`<p:sldId id="${255 + n}" r:id="${rid}"/>`);
    newRels.push(`<Relationship Id="${rid}" Type="${RT_SLIDE}" Target="slides/slide${n}.xml"/>`);
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT_SLIDE}"/>`);
  });
  for (const f of result.media) zip.file(`ppt/media/${f.name}`, f.data);

  // Embedded fonts (EOT .fntdata) so the deck renders with the original typefaces anywhere.
  let fontLst = "";
  let fontRid = maxRid + result.slides.length;
  let fontNo = 0;
  for (const font of result.fonts || []) {
    let slots = "";
    for (const slot of ["regular", "bold", "italic", "boldItalic"]) {
      if (!font.slots[slot]) continue;
      const rid = `rId${++fontRid}`;
      const file = `font${++fontNo}.fntdata`;
      zip.file(`ppt/fonts/${file}`, font.slots[slot]);
      newRels.push(`<Relationship Id="${rid}" Type="${RT_FONT}" Target="fonts/${file}"/>`);
      slots += `<p:${slot} r:id="${rid}"/>`;
    }
    const panose = (font.panose || []).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    fontLst += `<p:embeddedFont><p:font typeface="${escAttr(font.typeface)}"${panose.length === 20 ? ` panose="${panose}"` : ""} pitchFamily="2" charset="0"/>${slots}</p:embeddedFont>`;
  }

  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/, "");
  pres = pres.replace("</p:sldMasterIdLst>", `</p:sldMasterIdLst><p:sldIdLst>${sldIds.join("")}</p:sldIdLst>`);
  pres = pres.replace(/<p:sldSz [^>]*\/>/, `<p:sldSz cx="${result.widthEmu}" cy="${result.heightEmu}"/>`);
  if (fontLst) {
    pres = pres.replace(/(<p:notesSz [^>]*\/>)/, `$1<p:embeddedFontLst>${fontLst}</p:embeddedFontLst>`);
    pres = pres.replace(/ saveSubsetFonts="1"/, "").replace("<p:presentation ", '<p:presentation embedTrueTypeFonts="1" ');
  }
  presRels = presRels.replace("</Relationships>", `${newRels.join("")}</Relationships>`);
  const exts = new Set(result.media.map((f) => f.ext));
  if (fontLst) exts.add("fntdata");
  let defaults = "";
  for (const ext of exts) {
    if (!new RegExp(`Extension="${ext}"`, "i").test(types)) defaults += `<Default Extension="${ext}" ContentType="${MIME[ext] || "application/octet-stream"}"/>`;
  }
  types = types.replace(/(<Types[^>]*>)/, `$1${defaults}`).replace("</Types>", `${overrides.join("")}</Types>`);

  zip.file("ppt/presentation.xml", pres);
  zip.file("ppt/_rels/presentation.xml.rels", presRels);
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({
    type: outType,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}
