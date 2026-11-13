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

### Klávesové zkratky

| Klávesa | Nástroj | Klávesa | Nástroj |
|---|---|---|---|
| V | výběr | L | čára |
| H / mezerník | posun | A | šipka |
| P | pero | R | obdélník |
| M | zvýrazňovač | O | elipsa |
| E | guma | T | text |
| X | mazání tahů | Delete | smazat vybrané |

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
