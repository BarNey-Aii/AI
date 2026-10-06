"""Command line interface: python -m figma2pptx <figma-link> -o out.pptx"""

from __future__ import annotations

import argparse
import os
import sys

from . import FigmaError, Options, convert_json, convert_url


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="figma2pptx",
        description="Převede Figma snímek/rámec (odkaz) na editovatelný PPTX "
                    "se zachováním barev, gradientů, textů, obrázků a vektorů.")
    p.add_argument("source", nargs="?", help="Figma odkaz (…/design|slides/<KEY>/…?node-id=…)")
    p.add_argument("-o", "--output", default="figma.pptx", help="výstupní .pptx (výchozí figma.pptx)")
    p.add_argument("--token", default=os.environ.get("FIGMA_TOKEN"),
                   help="Figma Personal Access Token (nebo proměnná FIGMA_TOKEN)")
    p.add_argument("--slide-width", type=float, metavar="PALCE",
                   help="šířka snímku v palcích (např. 13.333 = PowerPoint 16:9, 10 = Google Slides 16:9). "
                        "Výchozí: přesná velikost z Figmy (1 px = 1/96 palce)")
    p.add_argument("--rasterize-gradients", action="store_true",
                   help="všechny gradienty vložit jako přesný PNG obrázek ve výplni tvaru "
                        "(100%% věrné i v Google Slides; tvar zůstává editovatelný)")
    p.add_argument("--font-weights", choices=["bold", "names"], default="bold",
                   help="'bold' = řez ≥600 jako tučné písmo; 'names' = název řezu v názvu fontu "
                        "(např. 'Inter SemiBold')")
    p.add_argument("--no-raster-fallback", action="store_true",
                   help="nevykreslovat masky/nepodporované prvky jako obrázek přes Figma API")
    p.add_argument("--all-pages", action="store_true",
                   help="bez node-id převést rámce ze všech stránek, ne jen z první")
    p.add_argument("--dump-json", metavar="SOUBOR", help="uložit stažená data z Figma API")
    p.add_argument("--from-json", metavar="SOUBOR",
                   help="offline převod z uloženého JSON (Figma API odpověď)")
    p.add_argument("--images-dir", metavar="ADRESÁŘ",
                   help="při --from-json: adresář s obrázky pojmenovanými <imageRef>.png/jpg")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    opts = Options(slide_width_in=args.slide_width,
                   rasterize_gradients=args.rasterize_gradients,
                   font_weights=args.font_weights,
                   raster_fallback=not args.no_raster_fallback)
    try:
        if args.from_json:
            data, warnings = convert_json(args.from_json, args.images_dir, opts, args.all_pages)
        else:
            if not args.source:
                print("Chybí Figma odkaz. Použití: python -m figma2pptx <odkaz> -o vystup.pptx",
                      file=sys.stderr)
                return 2
            data, warnings = convert_url(args.source, args.token, opts, args.all_pages, args.dump_json)
    except (FigmaError, ValueError) as exc:
        print(f"Chyba: {exc}", file=sys.stderr)
        return 1
    with open(args.output, "wb") as fh:
        fh.write(data)
    for w in dict.fromkeys(warnings):
        print(f"Upozornění: {w}", file=sys.stderr)
    print(f"Hotovo: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
