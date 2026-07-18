# PDF Presser – Lokaler PDF-Kompressor

**Live:** https://kmitulla.github.io/pdfcompress/

PDF-Dateien direkt im Browser verkleinern – **100 % lokal, ohne Upload**. Als
installierbare Web-App (PWA) funktioniert das Tool nach dem ersten Aufruf auch
**komplett offline**.

![Screenshot](docs/screenshot.png)

## Funktionen

- **Kein Upload:** Alle Verarbeitung (Rendern, Komprimieren, OCR) läuft per
  WebAssembly/JavaScript im Browser. Dateien verlassen das Gerät nie.
- **Kompressionsstufen:** Verlustfrei, Leicht, Mittel, Stark, Extrem
  (Graustufen), Extrem S/W – plus frei einstellbar (Farbmodus, dpi, Qualität).
- **„Scanner-Stil“ S/W-Modus:** 1-Bit-Binarisierung (Otsu-Schwellwert) mit
  **CCITT-G4-Fax-Kompression** – dieselbe Technik, die Büroscanner (z. B.
  Xerox) für winzige Scans nutzen. Text bleibt bei 300 dpi gestochen scharf,
  typischerweise nur wenige KB pro Seite. Pro Seite wird automatisch die
  kleinere von G4- und Flate-Kompression gewählt.
- **Optionaler OCR-Textlayer:** Tesseract (Deutsch/Englisch) legt unsichtbaren
  Text über die Seiten – das PDF wird durchsuch- und kopierbar.
- **PWA:** Web-App-Icon, installierbar (Desktop & Mobil), offline-fähig durch
  Service-Worker-Precache aller Assets inklusive OCR-Sprachdaten.
- **Für PC optimiert:** Zwei-Spalten-Layout, Drag & Drop, mehrere Dateien in
  einem Rutsch.

## Technik

| Baustein | Zweck |
| --- | --- |
| [pdf.js](https://mozilla.github.io/pdf.js/) | PDF-Seiten rendern |
| [pdf-lib](https://pdf-lib.js.org/) | Neues PDF zusammenbauen |
| Eigener CCITT-G4-Encoder (`js/ccitt-g4.js`) | 1-Bit-Fax-Kompression nach ITU-T T.6 |
| [tesseract.js](https://tesseract.projectnaptha.com/) | OCR als WebAssembly |

Alle Bibliotheken sind lokal gebündelt (`vendor/`), es gibt keine
CDN-Abhängigkeiten – Voraussetzung für den Offline-Betrieb.

## Lokal starten

```bash
npm install        # nur für Entwicklung/Tests nötig
npm run serve      # http://localhost:8823
```

## Tests

Ende-zu-Ende-Tests (Playwright) prüfen, dass die Kompression wirklich
funktioniert und korrekte PDFs herauskommen:

```bash
npm test
```

- Alle Stufen erzeugen gültige, kleinere PDFs (Seitenzahl, Maße, Inhalt werden
  gerendert und geprüft)
- G4-Encoder: Pixel-exakter Vergleich gegen den unabhängigen Flate-Referenzpfad
- OCR: Scan ohne Textlayer → Ausgabe enthält den erkannten Text
- UI-Workflow inkl. Download
- PWA: Manifest, Icons, Service Worker, App läuft und komprimiert offline

## Deployment

Jeder Push auf `main` veröffentlicht die App automatisch über GitHub Actions
auf GitHub Pages (`.github/workflows/deploy-pages.yml`).
