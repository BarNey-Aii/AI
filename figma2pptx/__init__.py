"""figma2pptx – převod Figma snímků/rámců do editovatelného PPTX."""

from __future__ import annotations

import io
import json

from .converter import Converter, Options
from .figma_api import (FigmaAssetProvider, FigmaClient, FigmaError, LocalAssetProvider,
                        find_slide_nodes, parse_figma_url)

__all__ = ["convert_url", "convert_json", "Options", "FigmaError", "parse_figma_url"]
__version__ = "1.0.0"


def convert_url(url: str, token: str, options: Options | None = None,
                all_pages: bool = False, dump_json: str | None = None):
    """Download the linked Figma node(s) and return (pptx_bytes, warnings)."""
    link = parse_figma_url(url)
    client = FigmaClient(token)
    if link.node_ids:
        nodes = client.get_nodes(link.file_key, link.node_ids)
        slides = []
        for nid in link.node_ids:
            slides.extend(find_slide_nodes(nodes[nid], all_pages))
        raw = {"nodes": nodes}
    else:
        doc = client.get_file(link.file_key)["document"]
        slides = find_slide_nodes(doc, all_pages)
        raw = {"document": doc}
    if dump_json:
        with open(dump_json, "w", encoding="utf-8") as fh:
            json.dump(raw, fh, ensure_ascii=False)
    assets = FigmaAssetProvider(client, link.file_key)
    return _convert(slides, assets, options)


def convert_json(path: str, images_dir: str | None = None, options: Options | None = None,
                 all_pages: bool = False):
    """Offline conversion from a saved Figma API response (``--dump-json`` output,
    a /v1/files response or a /v1/files/:key/nodes response)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    roots = []
    if "document" in data:
        roots.append(data["document"])
    for entry in (data.get("nodes") or {}).values():
        roots.append(entry.get("document", entry))
    if not roots:
        roots.append(data)
    slides = [s for r in roots for s in find_slide_nodes(r, all_pages)]
    return _convert(slides, LocalAssetProvider(images_dir), options)


def _convert(slides, assets, options):
    conv = Converter(assets, options)
    prs = conv.convert(slides)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), conv.warnings
