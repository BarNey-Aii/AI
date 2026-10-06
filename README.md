# figma2pptx – Figma → editovatelný PPTX

Nástroj stáhne snímek/rámec z Figmy přes oficiální REST API a postaví z něj **nativní
PowerPoint objekty** (tvary, textová pole, obrázky, skupiny) – ne obrázek celé stránky.
Výsledný `.pptx` jde upravovat v PowerPointu, Keynote i po importu do Google Slides.

## Figma Slides → plugin (nutné pro soubory Figma Slides)

**Figma REST API soubory Figma Slides nepodporuje** – vrací
`400 File type not supported by this endpoint`. Proto je převodník také jako **Figma plugin**,
který čte snímky přímo v editoru přes Plugin API (Slides podporuje) a stáhne `.pptx`.

### Instalace pluginu
1. Stáhněte `figma2pptx-plugin.zip` (na Netlify webu odkaz „Stáhněte plugin“, v repozitáři `web/figma2pptx-plugin.zip`)
   a rozbalte. Případně použijte přímo složku `plugin/` z repozitáře.
2. Otevřete prezentaci v **desktopové aplikaci Figma**.
3. **Plugins → Development → Import plugin from manifest…** → `manifest.json`.
4. **Plugins → Development → Figma → PPTX (1:1)** → *Exportovat PPTX*.

Bez výběru se převedou všechny (nepřeskočené) snímky v pořadí prezentace; s výběrem jen vybrané.
Funguje i v běžných Design souborech (vybrané rámce, jinak všechny rámce stránky).

### Režimy
| Režim | Výsledek |
|---|---|
| **Věrný 1:1 + editovatelný** (výchozí) | vše, co PPTX umí, je nativní a editovatelné; masky, rozmazání (blur) a rámce s ořezem přečnívajícího obsahu se vloží jako přesný obrázek vykreslený Figmou |
| Maximálně editovatelný | vše nativně; rozmazání a ořezy se vynechají |
| Přesná kopie | každý snímek jako jeden obrázek – vzhled 100 %, needitovatelné |

### Písma vložená do PPTX
Plugin ukáže všechna písma použitá na snímcích. Přes **„+ Přidat soubory písem“** nahrajte jejich
`.ttf`/`.otf` (např. stažené z Google Fonts – statické řezy, ne „variable“). Plugin si je zapamatuje
pro příští exporty. Písma se vloží přímo do PPTX (formát EOT `ppt/fonts/*.fntdata`,
`embedTrueTypeFonts`) – klient je nemusí mít nainstalovaná.
- Řezy jako SemiBold/Medium se vkládají pod vlastním názvem (např. „Inter SemiBold“), protože PowerPoint
  zná jen regular/bold/italic.
- Písma, jejichž licence vkládání zakazuje (fsType), plugin odmítne.
- Vložená písma zobrazuje PowerPoint (Windows i Mac). Google Slides vložená písma z PPTX nepoužívá –
  použije vlastní Google Fonts se stejným názvem.

### Textová pole a obrázky
- Textová pole mají **„Změnit velikost obrazce podle textu“** (`spAutoFit`) – při editaci se přizpůsobí.
- Jednořádkové texty se nikdy nezalamují (`wrap="none"`); víceřádkové mají rezervu 0,3 em na šířku.
- Obrázky se ořezávají už při exportu přesně podle Figmy (FILL/FIT/CROP) a vkládají se jako **obrázky**
  (ne výplň tvaru) včetně zaoblených rohů – nedeformují se v žádné aplikaci. WebP a jiné formáty se převádí na PNG.

Sestavení pluginu ze zdrojů: `npm install && npm run build:plugin`.

## Webová verze na Netlify (pro Design soubory)

Celý převod běží **v prohlížeči** (JavaScript, `web/`). Netlify funkce
`netlify/functions/figma.mjs` je jen proxy na Figma API (prohlížeč ho kvůli CORS nemůže volat
přímo). Nic se neinstaluje, žádný Python na serveru.

### Nasazení
1. Na [app.netlify.com](https://app.netlify.com) zvolte **Add new site → Import an existing project → GitHub**
   a vyberte tento repozitář a větev.
2. Nastavení buildu se načte z `netlify.toml` (publish `web`, functions `netlify/functions`,
   bez build příkazu) – stačí **Deploy**.
3. Otevřete adresu webu, vložte Figma odkaz a token → stáhne se `.pptx`.

Alternativně z příkazové řádky: `npm i -g netlify-cli && netlify deploy --prod`
(v kořeni repozitáře).

Lokální spuštění webové verze: `netlify dev` → http://localhost:8888

### Testy webové verze
```bash
npm install
npm test
```

## Python verze (příkazová řádka)

Stejný převodník v Pythonu – vhodný pro dávkové převody bez prohlížeče.

### Instalace

```bash
pip install -r requirements.txt        # nebo: pip install .
```

Potřebujete **Figma Personal Access Token**: Figma → Settings → Security →
Personal access tokens → scope *File content: Read*.

```bash
export FIGMA_TOKEN=figd_xxx
```

### Použití

#### Příkazová řádka

```bash
# jeden snímek / rámec (odkaz zkopírovaný přes "Copy link to selection")
python -m figma2pptx "https://www.figma.com/design/KEY/Deck?node-id=12-34" -o deck.pptx

# celá stránka nebo celý Figma Slides soubor (odkaz bez node-id / na stránku)
python -m figma2pptx "https://www.figma.com/slides/KEY/Deck" -o deck.pptx
```

| Volba | Význam |
|---|---|
| `--slide-width 13.333` | přeškáluje na šířku PowerPoint 16:9 (`10` = Google Slides 16:9). Výchozí = přesná velikost z Figmy (1 px = 1/96″, 1920×1080 → 20×11,25″) |
| `--rasterize-gradients` | každý gradient se vloží jako přesně spočítaný PNG ve **výplni tvaru** – tvar zůstává editovatelný, barvy 1:1 i v Google Slides |
| `--font-weights names` | řezy písma jako název fontu (`Inter SemiBold`) místo pouhého tučného |
| `--no-raster-fallback` | nevykreslovat masky / nepodporované uzly jako obrázek |
| `--all-pages` | bez `node-id` převést rámce ze všech stránek |
| `--dump-json f.json` / `--from-json f.json --images-dir dir` | uložení dat z API a offline převod |

#### Lokální webové rozhraní (Python)

```bash
python -m figma2pptx.web          # http://127.0.0.1:8000
```

Vložíte odkaz + token, kliknete na *Převést* a stáhne se `.pptx`.

## Co se převádí

| Figma | PPTX |
|---|---|
| Rámec / snímek | snímek, výplň rámce → **pozadí snímku** |
| Frame, Group, Component, Instance | skupina tvarů (zachovaná hierarchie a názvy vrstev) |
| Rectangle (i různé rádiusy rohů), Ellipse | nativní tvar (rect / roundRect / ellipse / vlastní geometrie) |
| Vector, Star, Polygon, Boolean | vlastní geometrie (`custGeom`) z přesných cest Figmy |
| Line | čára vč. tloušťky, přerušování, zakončení |
| Solid barva | sRGB hex + průhlednost |
| Lineární gradient | nativní `gradFill` – úhel i pozice zastávek přepočítané tak, aby odpovídaly táhlům ve Figmě (ověřeno: průměrná odchylka < 1/255) |
| Radiální gradient | nativní radiální `gradFill` (pozice středu + poloměr přepočten) |
| Úhlový (angular) a diamond gradient | přesně spočítaný PNG ve výplni tvaru (PPTX je nativně nemá) |
| Více výplní na jednom prvku | vrstvy tvarů nad sebou ve skupině |
| Obrázkové výplně (Fill/Fit/Crop/Tile) | obrázek ve výplni tvaru s ořezem |
| Okraj Inside / Center / Outside | tvar se upraví o ½ tloušťky, aby okraj ležel přesně jako ve Figmě |
| Drop shadow / Inner shadow | `outerShdw` / `innerShdw` (offset, blur, spread, barva, alfa) |
| Text | textové pole: font, velikost, řez, kurzíva, barvy i gradient po znacích, prostrkání, výška řádku, zarovnání, podtržení, velká písmena, odrážky, odkazy |
| Průhlednost vrstvy | násobí se do barev |
| Maska, neznámé uzly | vykresleny přes Figma API jako PNG na přesné pozici |

## Omezení (dané formátem PPTX / Google Slides)

- **Ořez obsahu rámce (clip content), masky, blend módy, layer/background blur** PPTX nativně nemá.
  Masky se nahrazují obrázkem, blur se vynechává.
- **Fonty** musí být nainstalované v počítači (PowerPoint) – Google Slides použije Google Fonts, pokud font existuje.
  Jiné metriky písma mohou mírně změnit zalomení řádků.
- **Google Slides** při importu PPTX gradienty nemusí převést věrně (chování importu je mimo kontrolu
  tohoto nástroje). Pro 100% shodu barev v Google Slides použijte `--rasterize-gradients`.
- Netlify funkce mají limit velikosti odpovědi (řádově jednotky MB). Obrázky se nejdřív stahují přímo z Figma CDN; přes proxy jdou jen jako záloha.
- Na jednom tvaru umí PPTX jen jeden stín – použije se první viditelný.
- Rozdílné tloušťky jednotlivých stran okraje → použije se největší.
- Figma Slides: nástroj zpracovává uzly typu `SLIDE`; pokud by REST API pro konkrétní Slides soubor
  data nevrátilo, zkopírujte snímek do běžného Design souboru a převeďte odkaz odtud.

### Testy

```bash
python -m unittest discover -s tests -t .
```
