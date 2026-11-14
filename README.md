# Online tabule

Sdílená online tabule pro doučování v reálném čase. Lektor vytvoří tabuli, pošle odkaz
a všichni připojení (student, případně další) na ní mohou zároveň psát, kreslit a vkládat obrázky.

## Funkce

- **Sdílení odkazem** – „Vytvořit novou tabuli“ → tlačítko „Sdílet odkaz“ → poslat studentovi.
  Kdo má odkaz, může kreslit. Tabule se ukládá na server, takže se k ní lze vrátit i příští hodinu.
- **Živá spolupráce** – tahy ostatních jsou vidět už během kreslení, dále barevné kurzory se jmény a seznam připojených.
- **Nástroje** – pero, zvýrazňovač, guma (gumuje jako skutečná guma), mazání celých tahů,
  čára (Shift = po 15°), šipka, obdélník a elipsa (volitelně s výplní), text, obrázky.
- **Obrázky** – tlačítkem, vložením ze schránky (Ctrl+V, např. screenshot příkladu) nebo přetažením souboru.
  Nástrojem Výběr je lze posouvat a za roh zvětšovat.
- **Výběr** – posun, změna barvy, duplikace, smazání; dvojklik na text = úprava.
- **Zpět / Znovu** (Ctrl+Z / Ctrl+Y), vymazání celé tabule (lze vrátit), export do PNG.
- **Nekonečná plocha** – posun (ruka, mezerník + táhnout, kolečko myši, dva prsty), zoom (Ctrl + kolečko, gesto, tlačítka).
- **Pozadí** – čtverečky, linky, tečky nebo čisté.
- **Tablety a stylusy** – funguje na iPadu i s perem; když se použije stylus, prst slouží jen k posunu (ochrana proti dlani).
- Při výpadku spojení se čáry uloží a po znovupřipojení odešlou.

### Vylepšení pro doučování

- **Lektor a student** – kdo tabuli založí, je lektor (pozná ho to podle tajného klíče uloženého v prohlížeči).
  Lektor může tabuli pojmenovat (klik na název vlevo nahoře), mazat celé strany a **zamknout kreslení** studentům
  (ikona zámku) – student pak může jen ukazovat laserem. Přes „Sdílet odkaz → Lektorský odkaz“ si lektor otevře
  tabuli se stejnými právy na dalším zařízení (tento odkaz neposílejte studentům).
- **Více stran** – lišta dole: předchozí / další strana (PageUp / PageDown), přidat a smazat stranu.
- **Sledovat lektora** (volitelné) – student si může zapnout tlačítko „Sledovat lektora“; jeho pohled se pak
  posouvá, přibližuje a přepíná strany spolu s lektorem. Jakmile si student sám posune plochu, sledování se vypne.
- **Laserové ukazovátko** (K) – červená stopa, která po chvíli zmizí; funguje i na zamčené tabuli.
- **Matematika** (ikona Σ): pravítko (měří délku v jednotkách mřížky, 1 j = 1 čtvereček),
  úhloměr (vrchol → první rameno → druhé rameno), souřadnicové osy jedním klikem a **vzorce v LaTeXu**
  s tlačítky pro zlomky, odmocniny, mocniny, soustavy rovnic apod. Dvojklik na vzorec = úprava.
- **Útvary a tělesa** (Σ → Útvary a tělesa, nebo klávesa G) – čtverec, obdélník, trojúhelník, pravoúhlý trojúhelník,
  rovnoběžník, lichoběžník, pravidelný n-úhelník, kruh; krychle, kvádr, trojboký hranol, jehlan, kužel, válec, koule.
  Tělesa jsou ve volném rovnoběžném promítání s neviditelnými hranami čárkovaně. Po vybrání se dole objeví panel:
  přesné rozměry (a, b, c, v, r…), jednotky (cm, mm, dm, m), zobrazení rozměrů, názvů vrcholů a výpočtu
  (obvod/obsah, objem/povrch). Velikost lze měnit i tažením za pravý dolní roh; 1 cm = 1 čtvereček mřížky.
- **Export** – PNG aktuální strany nebo **PDF všech stran** (např. jako zápis pro studenta po hodině).
- **Moje tabule** – úvodní stránka ukazuje tabule otevřené na tomto zařízení.
- **Vzhled** – bílá, tmavá nebo zelená školní tabule (tmavý inkoust se na tmavém pozadí zobrazí jako křída).

### Klávesové zkratky

| Klávesa | Nástroj | Klávesa | Nástroj |
|---|---|---|---|
| V | výběr | L | čára |
| H / mezerník | posun | A | šipka |
| P | pero | R | obdélník |
| M | zvýrazňovač | O | elipsa |
| E | guma | T | text |
| X | mazání tahů | Delete | smazat vybrané |
| K | laser | PageUp / PageDown | předchozí / další strana |
| G | útvary a tělesa | | |

## Spuštění na vlastním počítači

Je potřeba [Node.js](https://nodejs.org) 18 nebo novější.

```bash
npm install
npm start
```

Pak otevřete http://localhost:3000.

## Nasazení na internet (aby se student mohl připojit)

Aplikace je jeden Node.js server, dá se nasadit např. na **Render.com**, **Railway** nebo **Fly.io**:

1. Nahrajte repozitář na GitHub (už je).
2. Na Render.com: *New → Web Service* → vyberte repozitář.
   - Build command: `npm install`
   - Start command: `npm start`
3. Po nasazení dostanete adresu typu `https://vase-tabule.onrender.com`.

Tabule se ukládají jako JSON soubory do složky `data/` (lze změnit proměnnou `DATA_DIR`).
Na hostingu bez trvalého disku se po restartu serveru smažou – pro trvalé ukládání připojte
k službě perzistentní disk a nastavte na něj `DATA_DIR`. Port se bere z proměnné `PORT`.

## Vrácení vylepšení zpět

Vylepšení (lektor/zámek, strany, sledování lektora, laser, matematické pomůcky, útvary a tělesa, PDF, seznam tabulí, tmavé/zelené pozadí)
jsou v commitech označených **`[Vylepšení]`**. Verze před nimi je commit `eac3198`.

- Vrátit všechna vylepšení: `git revert --no-edit eac3198..HEAD`
- Vrátit jen některý commit: `git revert <hash>` (hash najdete přes `git log --oneline`)

Tabule uložené novou verzí zůstanou čitelné i ve staré verzi (strany navíc se ale zobrazí všechny přes sebe).
