"""Minimal local web UI: python -m figma2pptx.web  ->  http://127.0.0.1:8000"""

from __future__ import annotations

import argparse
import html
import os
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from . import FigmaError, Options, convert_url

PAGE = """<!doctype html>
<html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figma → PPTX</title>
<style>
:root {{ --bg:#f6f6f8; --card:#fff; --text:#1d1d22; --muted:#6b6b76; --accent:#5b4bff; --err:#c62828; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#141418; --card:#1f1f25; --text:#ececf1; --muted:#9a9aa6; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }}
main {{ max-width:640px; margin:40px auto; padding:0 16px; }}
.card {{ background:var(--card); border-radius:14px; padding:28px; box-shadow:0 2px 16px rgba(0,0,0,.06); }}
h1 {{ margin:0 0 4px; font-size:24px; }} p.sub {{ margin:0 0 24px; color:var(--muted); }}
label {{ display:block; font-weight:600; margin:16px 0 6px; }}
input[type=text], input[type=password], input[type=number], select {{ width:100%; padding:10px 12px; border-radius:8px;
  border:1px solid rgba(127,127,140,.35); background:transparent; color:inherit; font:inherit; }}
.row {{ display:flex; gap:10px; align-items:center; margin-top:12px; }} .row label {{ margin:0; font-weight:400; }}
small {{ color:var(--muted); }}
button {{ margin-top:24px; width:100%; padding:12px; border:0; border-radius:10px; background:var(--accent);
  color:#fff; font:600 16px system-ui; cursor:pointer; }}
.err {{ color:var(--err); background:rgba(198,40,40,.08); padding:12px; border-radius:8px; margin-bottom:16px; white-space:pre-wrap; }}
</style></head><body><main><div class="card">
<h1>Figma → PPTX</h1>
<p class="sub">Vložte odkaz na Figma snímek/rámec. Vznikne editovatelný .pptx pro PowerPoint i Google Slides.</p>
{error}
<form method="post" action="/convert">
<label for="url">Odkaz na Figma</label>
<input id="url" name="url" type="text" required placeholder="https://www.figma.com/design/KEY/Nazev?node-id=1-2" value="{url}">
<label for="token">Figma Personal Access Token</label>
<input id="token" name="token" type="password" placeholder="{token_ph}" autocomplete="off">
<small>Figma → Settings → Security → Personal access tokens (scope: File content – read).</small>
<label for="width">Šířka snímku</label>
<select id="width" name="width">
<option value="">Přesně podle Figmy (1 px = 1/96 palce)</option>
<option value="13.333">PowerPoint 16:9 (13,33 palce)</option>
<option value="10">Google Slides 16:9 (10 palců)</option>
</select>
<div class="row"><input id="rg" name="rasterize" type="checkbox" value="1">
<label for="rg">Gradienty jako přesný obrázek ve výplni (nejvěrnější v Google Slides)</label></div>
<div class="row"><input id="fw" name="weights" type="checkbox" value="names">
<label for="fw">Řezy písma v názvu fontu (např. „Inter SemiBold“)</label></div>
<button type="submit">Převést a stáhnout PPTX</button>
</form></div></main></body></html>"""


def _filename(url: str) -> str:
    m = re.search(r"figma\.com/[a-z]+/[A-Za-z0-9]+/([^/?#]+)", url)
    name = m.group(1) if m else "figma"
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-") or "figma"
    return f"{name}.pptx"


class Handler(BaseHTTPRequestHandler):
    default_token = os.environ.get("FIGMA_TOKEN", "")

    def _page(self, error: str = "", url: str = "", status: int = 200) -> None:
        err = f'<div class="err">{html.escape(error)}</div>' if error else ""
        ph = "(použije se FIGMA_TOKEN ze serveru)" if self.default_token else "figd_…"
        body = PAGE.format(error=err, url=html.escape(url), token_ph=ph).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._page()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
        url = form.get("url", "")
        token = form.get("token") or self.default_token
        opts = Options(
            slide_width_in=float(form["width"]) if form.get("width") else None,
            rasterize_gradients=form.get("rasterize") == "1",
            font_weights="names" if form.get("weights") == "names" else "bold",
        )
        try:
            data, warnings = convert_url(url, token, opts)
        except (FigmaError, ValueError) as exc:
            return self._page(str(exc), url, 400)
        except Exception as exc:  # pragma: no cover - surfaced to the user
            traceback.print_exc()
            return self._page(f"Neočekávaná chyba: {exc}", url, 500)
        for w in dict.fromkeys(warnings):
            print("Upozornění:", w)
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        self.send_header("Content-Disposition", f'attachment; filename="{_filename(url)}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Webové rozhraní pro figma2pptx")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args(argv)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"figma2pptx běží na http://{a.host}:{a.port}  (Ctrl+C ukončí)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
