# PDF Presser auf dem Mini-PC: Portainer, Epson-Scanner & NAS → Paperless

Diese Anleitung richtet den kompletten Ablauf ein, den du dir vorgestellt hast:

> Am Handy die Web-App öffnen → Seite(n) am **Epson ET-2720** einscannen →
> zuschneiden/bearbeiten → komprimieren → direkt in einen **Ordner auf dem NAS**
> legen → **Paperless** verarbeitet die Datei automatisch.

## Warum es einen kleinen Server-Dienst braucht

Die App war bisher **rein im Browser** (nur Frontend). Ein Browser – erst recht
am Handy – kann aber **weder einen Netzwerk-Scanner direkt ansprechen** (der
Epson spricht das eSCL-/AirScan-Protokoll, aber ohne CORS-Freigabe kommt der
Browser nicht dran) **noch in einen NAS-Ordner (SMB/NFS) schreiben**.

Deshalb liegt jetzt ein **schlankes Backend** bei (`server/`), das genau diese
zwei Dinge übernimmt und gleichzeitig die Web-App ausliefert – alles in **einem
Docker-Container**. Die eigentliche Verarbeitung (Rendern, Zuschneiden, OCR,
Kompression) läuft weiterhin komplett lokal im Browser.

```
 Handy-Browser ──HTTP──► pdfpresser-Container (Mini-PC)
   │  Web-App (Scan-Editor, Kompression, OCR laufen im Browser)
   │
   ├─ POST /api/scanner/scan ─► eSCL ─► Epson ET-2720 (im LAN)
   └─ POST /api/save ─────────► schreibt PDF in ►  NAS-Ordner ──► Paperless
```

---

## Voraussetzungen

- Mini-PC mit installiertem **Docker** (und Docker Compose v2).
- Epson **ET-2720** im **gleichen Netzwerk** wie der Mini-PC, eingeschaltet.
- Ein **NAS-Freigabeordner**, den Paperless als „consume"-Ordner überwacht.

---

## Teil 1 – Portainer als Web-App installieren

Falls Portainer noch nicht läuft, einmalig auf dem Mini-PC:

```bash
docker volume create portainer_data
docker run -d \
  --name portainer \
  --restart=always \
  -p 9443:9443 -p 8000:8000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Danach im Browser **https://MINIPC-IP:9443** öffnen und das Admin-Konto anlegen.
(Das Zertifikat ist selbstsigniert – die Warnung einmal bestätigen.)

---

## Teil 2 – Epson ET-2720 fürs Netzwerk-Scannen vorbereiten

Der ET-2720 kann eSCL/AirScan **ab Werk**, sobald er im WLAN hängt. Zu tun:

1. **Ins Netz bringen:** Am Drucker `Einstellungen → WLAN-Setup` (oder per
   Epson-Smart-Panel-App) mit deinem WLAN verbinden.
2. **IP-Adresse herausfinden:** Am Gerät `Einstellungen → Netzwerkstatus`
   zeigt die IP (z. B. `192.168.1.50`). Alternativ im Router unter den
   DHCP-Clients nach „EPSON…" suchen.
3. **Feste IP empfehlenswert:** Im Router für den Drucker eine
   **DHCP-Reservierung** setzen, damit sich die IP nie ändert. Sonst musst du
   `SCANNER_HOST` bei jedem IP-Wechsel anpassen.

**Schnelltest**, ob eSCL antwortet (vom Mini-PC aus):

```bash
curl -sk http://192.168.1.50/eSCL/ScannerCapabilities | head -c 300
```

Kommt XML mit `MakeAndModel` zurück, ist alles bereit. Kommt nichts:
- Manche Firmware nutzt HTTPS: `curl -sk https://192.168.1.50/eSCL/ScannerCapabilities`.
  Dann `SCANNER_HOST=https://192.168.1.50` setzen.
- In **Web Config** des Druckers (`http://DRUCKER-IP` im Browser) prüfen, dass
  Scannen im Netzwerk / AirPrint aktiviert ist.

> Der ET-2720 hat nur eine **Glasfläche** (kein Einzug). Pro Klick wird **eine
> Seite** eingelesen; für mehrere Seiten legst du nacheinander auf und scannst
> erneut – im Scan-Editor werden sie zu einem PDF gesammelt.

---

## Teil 3 – NAS-Ordner für Paperless bereitstellen

Paperless überwacht einen **„consume"-Ordner**: Alles, was dort landet, wird
automatisch eingelesen. Der pdfpresser-Container muss in **genau diesen Ordner**
schreiben können. Zwei gängige Wege:

### Variante A: NAS-Freigabe auf dem Mini-PC mounten (empfohlen, wenn Paperless auf dem NAS läuft)

Auf dem Mini-PC die SMB-Freigabe dauerhaft einbinden, z. B. in `/etc/fstab`:

```
//NAS-IP/paperless-consume  /mnt/nas/consume  cifs  credentials=/etc/nas.cred,uid=1000,gid=1000,iocharset=utf8  0  0
```

`/etc/nas.cred` enthält `username=…` und `password=…`. Danach `sudo mount -a`.
Der Host-Pfad ist dann `/mnt/nas/consume`.

### Variante B: Paperless im selben Docker-Stack (kein NAS-Mount nötig)

In `docker-compose.yml` sind die Paperless-Zeilen als optionaler Block schon
vorbereitet. Aktivierst du sie, teilen sich pdfpresser und Paperless ein
gemeinsames **Named Volume** `paperless_consume` – dann ist `CONSUME_HOST_PATH`
egal, du mountest stattdessen `paperless_consume:/data/consume`.

---

## Teil 4 – Den PDF-Presser-Stack in Portainer deployen

**Portainer → Stacks → Add stack.** Name z. B. `pdfpresser`. Dann **entweder**:

- **Repository:** Repository-URL `https://github.com/kmitulla/pdfcompress`,
  Compose-Pfad `docker-compose.yml`. Portainer klont und baut selbst. **oder**
- **Web editor:** den Inhalt von `docker-compose.yml` einfügen.

Unter **Environment variables** setzen:

| Variable | Beispiel | Bedeutung |
| --- | --- | --- |
| `SCANNER_HOST` | `192.168.1.50` | IP/Host deines Epson (leer = Scanner-Funktion aus) |
| `CONSUME_HOST_PATH` | `/mnt/nas/consume` | NAS-/Consume-Ordner auf dem Host (Variante A) |

**Deploy the stack** klicken. Danach läuft die App unter
**http://MINIPC-IP:8823**.

Zwei Kontrollen:

```bash
curl -s http://MINIPC-IP:8823/api/config
#   {"scanner":true,"consume":true,"version":1}

curl -s http://MINIPC-IP:8823/api/scanner/status
#   {"ok":true,"model":"EPSON ET-2720 Series","host":"192.168.1.50"}
```

Sind beide Werte `true` bzw. `ok:true`, erscheinen in der App automatisch die
Kachel **„Netzwerk-Scanner"** und pro Datei der Button **„📥 An Paperless (NAS)"**.

---

## Teil 5 – Paperless die Datei verarbeiten lassen

Sobald ein PDF im consume-Ordner landet, zieht Paperless es von selbst ein
(OCR, Tags, Ablage). Der Server schreibt **atomar** (erst `.name.pdf.part`, dann
Umbenennen), damit Paperless nie eine halb geschriebene Datei erwischt.

Läuft Paperless noch nicht: Der optionale Block in `docker-compose.yml` bringt
eine Minimal-Konfiguration mit. Für den Produktivbetrieb lohnt die offizielle
Paperless-ngx-Compose mit Postgres – dort einfach denselben consume-Ordner
verwenden.

---

## Wo läuft eigentlich die Rechenarbeit?

**Auf deinem Gerät – nicht auf dem Mini-PC.** Rendern, Zuschneiden, Kompression
und OCR laufen als WebAssembly/JavaScript im Browser (iPhone bzw. Laptop). Der
Mini-PC liefert nur die App aus und erledigt die zwei Dinge, die ein Browser
nicht darf:

| Aufgabe | Läuft auf |
| --- | --- |
| Seiten rendern, zuschneiden, entzerren | **Handy/Laptop** (Browser) |
| Kompression (JPEG, CCITT-G4, Palette) | **Handy/Laptop** (Browser) |
| OCR (Tesseract) | **Handy/Laptop** (Browser) |
| Scanner ansprechen (eSCL) | Mini-PC (Server) |
| Datei in den Ordner schreiben | Mini-PC (Server) |
| Einstellungen/Unterschriften ablegen | Mini-PC (Server) |

Der Mini-PC bleibt also praktisch unbelastet. Umgekehrt heißt das: bei sehr
großen Scans rechnet das iPhone spürbar. Die „Scanner-Stil“-Stufen sind dafür
die effizientesten.

---

## Stapel-Scan: mehrere Seiten ohne Antippen

In der Zeile **Scanner** stehen **Seiten** und **Pause**:

- **Seiten** = wie viele Blätter du scannen willst (1–99).
- **Pause** = Sekunden zwischen zwei Scans, damit du die Vorlage wechseln
  kannst (erscheint ab 2 Seiten, Standard 8 s).

Einmal auf **Netzwerk-Scanner** tippen genügt dann: Die App scannt die
eingestellte Anzahl automatisch nacheinander, zählt zwischendurch sichtbar
herunter („nächster Scan in 5 s … Vorlage wechseln") und legt jede Seite gleich
mit passendem Zuschnitt ab. Danach landest du in der Seitenübersicht, wo du
prüfen, drehen, zuschneiden oder radieren kannst.

**Vorzeitig beenden:** Der Knopf **„Stapel stoppen"** oben beendet die Reihe;
die bereits eingelesenen Seiten bleiben erhalten. Schlägt ein einzelner Scan
fehl, endet der Stapel ebenfalls, ohne die vorherigen Seiten zu verlieren.

Alle Einstellungen – Auflösung, Farbe, Seitenzahl und Pause – werden gemerkt
und stehen beim nächsten Mal wieder so da (in der selbst gehosteten Variante
sogar geräteübergreifend).

## Mehrseitige PDFs am Stück scannen

Genau dafür ist der Ablauf gebaut – Beispiel „3 Seiten, dann 4, dann 1“:

1. **„Netzwerk-Scanner“** antippen → erste Seite wird eingelesen und öffnet sich
   im Zuschnitt-Editor → **Übernehmen**.
2. In der Seitenübersicht **„Nächste Seite scannen“** → nächste Vorlage auflegen
   → übernehmen. Beliebig oft wiederholen (hier also 3×).
3. **„Als PDF übernehmen“** → alle gesammelten Seiten werden **eine** PDF.
4. Kompressionsstufe wählen → **Komprimieren** → **„An Paperless“**.
5. Für die nächste PDF (4 Seiten) einfach wieder bei 1. anfangen. Die zuletzt
   gewählte **Kompressionsstufe bleibt erhalten** – du musst nichts neu
   einstellen.

**Einstellungen pro Seite:** Standardmäßig gilt eine Stufe für alle Seiten.
Braucht eine einzelne Seite etwas anderes (z. B. Seite 3 in Farbe, Rest S/W),
in der **Vorschau** zur Seite blättern und dort unter „Nur diese Seite“ eine
eigene Stufe samt Helligkeit setzen.

**Ohne Extra-Tipp speichern:** Unter *Speichern* die Option **„Nach dem
Komprimieren automatisch an Paperless senden“** aktivieren – dann landet jede
fertige PDF direkt im überwachten Ordner.

---

## A4-Ausschnitt automatisch bei Flachbett-Scans

Die Glasfläche des ET-2720 ist **breiter als A4**: gemessen **215,9 × 297 mm**
(Letter-Breite bei A4-Höhe). Ein Scan hat rechts also gut **6 mm Überstand**,
die Höhe stimmt exakt. Weil die Vorlage bündig in der Ecke liegt, steht der
A4-Bereich rechnerisch fest – Kantenerkennung ist dafür gar nicht nötig (und
würde bei weißem Blatt auf weißem Deckel ohnehin scheitern).

Die Blattkante wird **gemessen**, nicht geraten – und zwar je Achse getrennt,
weil sie nicht immer auf allen Seiten sichtbar ist:

1. **Gemessen:** Wo die Glasfläche frei bleibt, ist der Scan dunkler – oder es
   zeigt sich zumindest eine **feine Schattenlinie** direkt an der Blattkante
   (im echten Scan gemessen: Helligkeit 249 statt 255). Beides wird erkannt;
   Textzeilen in Randnähe werden über Tiefe und Breite der Senke ausgeschlossen.
2. **Gerechnet (Rückfall):** Findet sich auf einer Seite keine Kante – weißes
   Papier vor weißem Deckel gibt schlicht kein Signal –, wird aus Pixelgröße
   und Scanauflösung (`X-Scan-Dpi` vom Server) die Glasfläche in Millimetern
   bestimmt und A4 ab der Anlegeecke abgezogen.

Das erkannte Blatt wird anschließend **exakt auf A4 abgebildet** (Hoch- oder
Querformat nach Seitenverhältnis, mit Strecken). Damit ist die Ausgabe genau
A4 – ohne weißen Rand und ohne abgeschnittene Kante. Nebeneffekt: eine leichte
Maßabweichung des Scanners wird dabei mit korrigiert.

- **„A4-Fläche“** setzt den Ausschnitt jederzeit neu.
- **„Ecke“** schaltet die Anlegekante durch (oben links → oben rechts → unten
  rechts → unten links), falls dein Gerät anders anlegt.
- Bei **Kamerafotos** greift diese Automatik nicht – dort bleibt die
  perspektivische Eckenerkennung zuständig.

### Auswahl und Ausgabeformat sind getrennt

Die Leiste im Zuschnitt hat zwei beschriftete Gruppen, die sich frei
kombinieren lassen:

| Gruppe | Wirkung |
| --- | --- |
| **Auswahl** | *Alles* (ganzes Bild) · *Automatisch* (Ränder erkennen) · *A4-Fläche* · *Ecke* |
| **Ausgabeformat** | *Auto* (folgt der Auswahl) · *A4 hoch* · *A4 quer* · *strecken* |

Also z. B.: alles auswählen → *A4 quer* → optional *strecken*.

## Scanauflösung einstellen

Unter den Quellen-Kacheln steht eine Zeile **Scanner** mit **Auflösung**
(150–600 dpi, Standard 300) und **Farbe** (Farbe / Graustufen / Schwarz-Weiß).
Beides wird direkt an den Epson übergeben – der Scanner nimmt also gleich in
der gewünschten Auflösung auf.

Höhere Auflösung heißt feinere Vorlage, aber auch längeres Scannen und mehr
Rechenzeit **auf deinem Gerät** (das Verarbeiten läuft ja im Browser). Für
normale Briefe reichen 300 dpi; 600 dpi lohnt bei kleiner Schrift oder wenn
anschließend OCR laufen soll.

## S/W-Scans feinjustieren („Fax-Look“)

Für die 1-Bit-Ausgabe gibt es drei Regler, die zusammenspielen:

| Einstellung | Wirkung |
| --- | --- |
| **Helligkeit** | verschiebt den Schwellwert: + mehr Weiß, − mehr Schwarz |
| **Kontrast** | + nimmt auch schwachen/blassen Text mit · − lässt nur kräftige Tinte stehen (weniger Rauschen, kleinere Datei) |
| **Dunkle Flächen** | *Als Farbbalken* (Fläche schwarz, weiße Schrift bleibt lesbar) · *Ignorieren* (nicht schwärzen) · *Automatisch* |

**Wenn der Rand schwarz zuläuft** – typisch bei Fotos, Bildschirmaufnahmen oder
starker Vignette –, liegt das an der Balken-Inversion: Sie ist für Briefköpfe
mit weißer Schrift gedacht, macht aus flächigem Rauschen aber eine schwarze
Masse. *Automatisch* erkennt solche Aufnahmen inzwischen selbst (wenn über
22 % der Seite dunkel sind) und schaltet die Inversion ab; mit *Ignorieren*
lässt es sich erzwingen. An einer echten Bildschirmaufnahme gemessen fiel der
Schwarzanteil am linken Rand damit von **93 % auf 15 %**, während der Text
vollständig erhalten blieb – die zuvor verschluckte linke Spalte ist wieder
lesbar.

Faustregel bei problematischen Vorlagen: erst **Dunkle Flächen → Ignorieren**,
dann mit **Kontrast** nachjustieren (negativ = sauberer Hintergrund, positiv =
mehr Details), zuletzt die **Helligkeit**. Die Vorschau zeigt jede Änderung
sofort.

## Scans prüfen und nachbessern

- In der Seitenübersicht sind die Miniaturen groß; ein Tipp darauf öffnet die
  **Vollbild-Vorschau** mit Blättern und direkten Schaltflächen für
  **Zuschnitt** und **Radieren**.
- Der **Scan-Radierer lässt sich zoomen** – mit zwei Fingern, über die
  Zoom-Tasten oder am Rechner per Mausrad. Dabei wird der Ausschnitt aus einer
  hochauflösenden Arbeitskopie neu gezeichnet, man sieht also wirklich mehr
  Details statt eines vergrößerten Unschärfebreis. Ein Finger radiert, und der
  Pinsel wird im Zoom entsprechend feiner.
- **Nachträglich radieren:** Ist der Scan schon als PDF in der Liste, öffnet
  **„Bearbeiten“** den PDF-Editor. Dort gibt es das Werkzeug **„Weiß
  übermalen“** – dieselbe Wirkung wie der Scanner-Radierer, aber zu jedem
  späteren Zeitpunkt und für jede PDF, auch für importierte. Die Übermalung
  wird beim Übernehmen fest eingebrannt und von der anschließenden Kompression
  miterfasst.

## Einstellungen & Unterschriften auf allen Geräten

In der **selbst gehosteten Variante** liegen Einstellungen, Unterschriften und
Stempel zusätzlich auf deinem Server (`DATA_DIR`, eigenes Docker-Volume). Du
unterschreibst also einmal am Laptop und hast die Unterschrift auch am iPhone.
In der Seitenleiste unter *Meine Daten* zeigt eine Zeile den Status an.

**Die öffentliche Version auf GitHub Pages hat kein Backend** – dort bleibt
weiterhin alles ausschließlich lokal im Browser (IndexedDB), es wird nichts
übertragen. Dasselbe Programm, zwei Betriebsarten:

| | GitHub Pages (öffentlich) | Selbst gehostet (dein Mini-PC) |
| --- | --- | --- |
| Verarbeitung | im Browser | im Browser |
| Speicherung von Einstellungen/Unterschriften | nur lokal im Browser | lokal **+** auf deinem Server |
| Netzwerk-Scanner | – | ✔ |
| An Paperless senden | – | ✔ |

---

## Teil 6 – Vom Handy nutzen

1. Am Handy **http://MINIPC-IP:8823** öffnen (gleiches WLAN).
2. Optional **als App installieren** (Browser-Menü → „Zum Startbildschirm").
3. Auf **„Netzwerk-Scanner"** tippen → Vorlage liegt auf dem Epson → die Seite
   wird geholt und öffnet sich im **Zuschnitt-Editor** (Ränder, A4,
   Perspektive, radieren). Für weitere Seiten erneut auf „Netzwerk-Scanner"
   bzw. im Editor „Seite hinzufügen".
4. **Fertig** → das Ergebnis landet als PDF in der Liste. Links
   **Kompressionsstufe** wählen (z. B. „Extrem S/W – Scanner-Stil"), optional
   **OCR** anhaken, **Komprimieren**.
5. **„📥 An Paperless (NAS)"** tippen → das PDF liegt im consume-Ordner,
   Paperless erledigt den Rest.

> **Wichtig zur Handy-*Kamera*:** Die Kamera-Scan-Funktion (`getUserMedia`)
> verlangt einen „sicheren Kontext" – über **http** im LAN blockiert das
> Handy die Kamera. Der **Netzwerk-Scanner** braucht die Kamera **nicht** und
> funktioniert über http problemlos. Willst du zusätzlich die Handy-Kamera als
> Quelle, stell der App HTTPS voran (z. B. Reverse Proxy mit
> Caddy/Traefik + Zertifikat, oder ein Tailscale-Hostname mit HTTPS).

---

## Updates einspielen

Der Stack baut das Image **aus dem Repository**. Ein Update ist deshalb immer
derselbe Dreisatz – wichtig ist nur, dass wirklich **neu gebaut** wird
(ein bloßer Container-Neustart nimmt weiter das alte Image):

**In Portainer (empfohlen):**
1. **Stacks → pdfpresser → Editor** öffnen.
2. Rechts **„Re-pull image and redeploy“** bzw. beim Update-Dialog
   **„Re-build image“** aktivieren.
3. **Update the stack**.

Falls Portainer hartnäckig das alte Image nimmt:
1. **Stacks → pdfpresser → Remove** (Volumes NICHT löschen – deine
   Unterschriften liegen in `pdfpresser_data`).
2. **Images →** `pdfpresser:latest` **→ Remove**.
3. **Stacks → Add stack** → dieselbe YAML → **Deploy**.

**Auf der Kommandozeile:**
```bash
docker compose build --no-cache && docker compose up -d
```

**Im Browser nachladen:** Die App ist eine PWA und hält sich einen Offline-Cache.
Nach einem Update lädt sie sich normalerweise **einmal automatisch neu**. Falls
doch etwas alt aussieht: Seite neu laden (am iPhone die Web-App einmal schließen
und wieder öffnen).

---

## Fehlersuche

| Symptom | Ursache / Lösung |
| --- | --- |
| Kachel „Netzwerk-Scanner" fehlt | `SCANNER_HOST` nicht gesetzt oder App über GitHub Pages statt über den Container geöffnet. `/api/config` prüfen. |
| `scanner status` → `ok:false`, Scan endet mit **HTTP 404** | eSCL läuft nur über **HTTPS** → `SCANNER_HOST: "https://192.168.178.69"`. Testen: `https://IP/eSCL/ScannerCapabilities` im Browser (Zertifikatswarnung ist normal, das Gerät hat ein selbstsigniertes Zertifikat). |
| Scan endet mit **HTTP 503** („belegt") | Ein vorheriger Auftrag hing. Wird jetzt automatisch sauber geschlossen und bis zu 4× wiederholt. Bleibt es dabei: Scanner einmal aus-/einschalten. |
| **EACCES** beim Speichern | Der Zielordner gehört root, der Container läuft als `node`. `user: "0:0"` beim Service setzen (steht in der Compose). |
| CIFS-Mount: **invalid argument** | Das NAS-Passwort enthält ein **Komma** – die Optionen sind kommagetrennt. Passwort ohne Komma/Sonderzeichen vergeben. |
| CIFS-Mount: **Permission denied (13)** | Falscher Benutzer/Passwort oder fehlendes Schreibrecht auf die Freigabe. |
| CIFS-Mount: **Fehler 112 / Protokoll** | `vers=3.0` auf `vers=2.1` ändern, ggf. `,sec=ntlmssp` ergänzen. |
| Portainer: **pull access denied for pdfpresser** | Das Image existiert noch nicht. Die Compose enthält einen `build:`-Block – sicherstellen, dass er drinsteht, bzw. Image vorher unter *Images → Build a new image* bauen. |
| Button „An Paperless" fehlt | `CONSUME_DIR`/Volume nicht gemountet. `/api/config` → `consume` muss `true` sein. |
| Paperless sieht die Datei nicht | Mountet der Container denselben Ordner, den Paperless überwacht? Rechte (uid/gid) prüfen. |
| Unterschriften nach Update weg | Volume `pdfpresser_data` fehlt oder wurde mitgelöscht. |
| Kamera-Scan am Handy geht nicht | http ist kein sicherer Kontext → HTTPS voranstellen. Der **Netzwerk-Scanner** ist davon nicht betroffen. |

---

## Lokal ausprobieren (ohne Docker)

```bash
SCANNER_HOST=192.168.1.50 CONSUME_DIR=./consume node server/index.mjs
# → http://localhost:8823
```

Ohne gesetzte Variablen läuft die App wie gehabt als reines Frontend; die
Scanner-/Paperless-Funktionen bleiben dann einfach ausgeblendet.
