"""Figma REST API client and URL parsing."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qs, unquote, urlparse

import requests

API_BASE = "https://api.figma.com/v1"

_URL_RE = re.compile(
    r"figma\.com/(?:file|design|slides|deck|proto|board)/([A-Za-z0-9]+)"
    r"(?:/branch/([A-Za-z0-9]+))?"
)


class FigmaError(RuntimeError):
    pass


@dataclass
class FigmaLink:
    file_key: str
    node_ids: list[str] = field(default_factory=list)


def parse_figma_url(url: str) -> FigmaLink:
    """Extract the file key and node ids from any figma.com link.

    Supports /file/, /design/, /slides/, /deck/, /proto/ links, branch links
    and ``node-id`` query parameters in both ``1-2`` and ``1:2`` form.
    """
    url = url.strip()
    m = _URL_RE.search(url)
    if not m:
        raise FigmaError(
            "Neplatný Figma odkaz. Očekávám např. "
            "https://www.figma.com/design/<KEY>/Nazev?node-id=1-2"
        )
    file_key = m.group(2) or m.group(1)
    query = parse_qs(urlparse(url).query)
    node_ids: list[str] = []
    for raw in query.get("node-id", []):
        for part in unquote(raw).split(","):
            part = part.strip()
            if part:
                node_ids.append(part.replace("-", ":"))
    return FigmaLink(file_key=file_key, node_ids=node_ids)


class FigmaClient:
    """Thin wrapper over the endpoints the converter needs."""

    def __init__(self, token: str, timeout: float = 120.0):
        if not token:
            raise FigmaError(
                "Chybí Figma Personal Access Token (parametr --token nebo "
                "proměnná prostředí FIGMA_TOKEN)."
            )
        self.session = requests.Session()
        self.session.headers["X-Figma-Token"] = token
        self.timeout = timeout

    def _get(self, path: str, params: dict | None = None) -> dict:
        url = f"{API_BASE}{path}"
        for attempt in range(6):
            resp = self.session.get(url, params=params, timeout=self.timeout)
            if resp.status_code == 429:
                wait = float(resp.headers.get("Retry-After", 2 ** attempt))
                time.sleep(min(wait, 60))
                continue
            if resp.status_code == 403:
                raise FigmaError(
                    "Figma API vrátilo 403 – token je neplatný nebo nemá "
                    "přístup k souboru (scope file_content:read)."
                )
            if resp.status_code == 404:
                raise FigmaError("Figma soubor nebo uzel nebyl nalezen (404).")
            if not resp.ok:
                raise FigmaError(f"Figma API chyba {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            if data.get("err"):
                raise FigmaError(f"Figma API chyba: {data['err']}")
            return data
        raise FigmaError("Figma API: překročen limit požadavků (429).")

    def get_file(self, file_key: str) -> dict:
        return self._get(f"/files/{file_key}", {"geometry": "paths"})

    def get_nodes(self, file_key: str, node_ids: list[str]) -> dict:
        data = self._get(
            f"/files/{file_key}/nodes",
            {"ids": ",".join(node_ids), "geometry": "paths"},
        )
        nodes = {}
        for nid, entry in (data.get("nodes") or {}).items():
            if entry is None:
                raise FigmaError(f"Uzel {nid} nebyl v souboru nalezen.")
            nodes[nid] = entry["document"]
        return nodes

    def get_image_fill_urls(self, file_key: str) -> dict[str, str]:
        data = self._get(f"/files/{file_key}/images")
        return (data.get("meta") or {}).get("images") or {}

    def render_nodes(self, file_key: str, node_ids: list[str], scale: float = 2.0) -> dict[str, str]:
        out: dict[str, str] = {}
        for i in range(0, len(node_ids), 50):
            chunk = node_ids[i : i + 50]
            data = self._get(
                f"/images/{file_key}",
                {
                    "ids": ",".join(chunk),
                    "format": "png",
                    "scale": scale,
                    "use_absolute_bounds": "true",
                },
            )
            out.update({k: v for k, v in (data.get("images") or {}).items() if v})
        return out

    def download(self, url: str) -> bytes:
        # Image URLs are pre-signed S3 links; they must not get the token header.
        resp = requests.get(url, timeout=self.timeout)
        resp.raise_for_status()
        return resp.content


class AssetProvider:
    """Interface used by the converter to fetch binary assets."""

    def image_fill(self, image_ref: str) -> bytes | None:  # pragma: no cover - interface
        return None

    def can_render(self) -> bool:
        return False

    def render_nodes(self, node_ids: list[str]) -> dict[str, bytes]:  # pragma: no cover
        return {}


class FigmaAssetProvider(AssetProvider):
    def __init__(self, client: FigmaClient, file_key: str, render_scale: float = 2.0):
        self.client = client
        self.file_key = file_key
        self.render_scale = render_scale
        self._fill_urls: dict[str, str] | None = None
        self._cache: dict[str, bytes] = {}

    def image_fill(self, image_ref: str) -> bytes | None:
        if image_ref in self._cache:
            return self._cache[image_ref]
        if self._fill_urls is None:
            self._fill_urls = self.client.get_image_fill_urls(self.file_key)
        url = self._fill_urls.get(image_ref)
        if not url:
            return None
        data = self.client.download(url)
        self._cache[image_ref] = data
        return data

    def can_render(self) -> bool:
        return True

    def render_nodes(self, node_ids: list[str]) -> dict[str, bytes]:
        if not node_ids:
            return {}
        urls = self.client.render_nodes(self.file_key, node_ids, self.render_scale)
        return {nid: self.client.download(u) for nid, u in urls.items()}


class LocalAssetProvider(AssetProvider):
    """Offline provider: image fills are read from ``<dir>/<imageRef>.*``."""

    def __init__(self, images_dir: str | None):
        self.images_dir = images_dir

    def image_fill(self, image_ref: str) -> bytes | None:
        if not self.images_dir:
            return None
        import glob
        import os

        for path in glob.glob(os.path.join(self.images_dir, f"{image_ref}.*")):
            with open(path, "rb") as fh:
                return fh.read()
        return None


def find_slide_nodes(root: dict, include_all_pages: bool = False) -> list[dict]:
    """Return the nodes that should become slides, starting from ``root``.

    * SLIDE nodes (Figma Slides) anywhere below ``root`` win.
    * DOCUMENT  -> first page (or all pages) -> top-level frames.
    * CANVAS / SECTION -> its top-level frames.
    * Anything else (FRAME, COMPONENT, ...) is one slide on its own.
    """
    slides: list[dict] = []

    def collect_slides(node: dict) -> None:
        if node.get("type") == "SLIDE":
            if node.get("visible", True):
                slides.append(node)
            return
        for child in node.get("children") or []:
            collect_slides(child)

    collect_slides(root)
    if slides:
        return slides

    frame_types = {"FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP"}

    def frames_of(container: dict) -> list[dict]:
        out = []
        for child in container.get("children") or []:
            if not child.get("visible", True):
                continue
            if child.get("type") == "SECTION":
                out.extend(frames_of(child))
            elif child.get("type") in frame_types:
                out.append(child)
        return out

    t = root.get("type")
    if t == "DOCUMENT":
        pages = root.get("children") or []
        if not include_all_pages:
            pages = pages[:1]
        for page in pages:
            slides.extend(frames_of(page))
        return slides
    if t in ("CANVAS", "SECTION"):
        return frames_of(root)
    return [root]
