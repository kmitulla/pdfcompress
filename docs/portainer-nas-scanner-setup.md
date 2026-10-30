# PDF Presser auf dem ThinkCentre (ZimaOS/Portainer): Scanner, Paperless, Auto-Update

> Am Handy die App öffnen → fotografieren, hochladen oder am **Epson ET-2720**
> scannen → automatisch exakt **DIN A4** → komprimieren & Texterkennung →
> **an Paperless**. Neue Versionen spielt der Server von selbst ein.

```
 Handy/Laptop (Browser) ──HTTP──► pdfpresser-Container (ThinkCentre)
   │  Oberfläche, Zuschnitt, Kompression und OCR rechnen im Browser
   ├─ /api/scan-jobs ────► eSCL ─► Epson ET-2720 (LAN) – läuft auch ohne App weiter
   ├─ /api/save ─────────► Paperless-API  (oder consume-Ordner)
   └─ /api/raw  ─────────► Sammelordner „Scanner_RAW“
 ghcr.io/kmitulla/pdfcompress ◄── GitHub baut bei jedem Push ein Image
        ▲
        └── Watchtower (im selben Stack) holt neue Images alle 5 Minuten
```

---

## 1. Aktualisieren – der schnellste Weg (einmalig umstellen)

Bisher hat Portainer das Image bei jedem Update **auf dem ThinkCentre gebaut**.
Jetzt baut GitHub das Image fertig, der Server lädt es nur noch herunter – das
dauert Sekunden statt Minuten, und mit Watchtower passiert es automatisch.

### a) Einmalig: Image auf GitHub öffentlich machen

Nach dem ersten Push auf `main` baut der Workflow **„Docker-Image (GHCR)“**
(Reiter *Actions* im Repository, ca. 2–3 Minuten). Danach einmal:

1. GitHub → dein Profil → **Packages** → `pdfcompress`
2. **Package settings** → ganz unten **Change visibility** → **Public**

(Alternativ privat lassen und in Portainer unter *Registries* `ghcr.io` mit
einem GitHub-Token mit Recht `read:packages` hinterlegen.)

### b) Einmalig: Stack in Portainer umstellen

1. **Portainer → Stacks → pdfpresser → Editor**
2. Den Inhalt durch die neue [`docker-compose.yml`](../docker-compose.yml)
   ersetzen. **Stack-Namen beibehalten** – dann bleiben die Volumes mit
   Unterschriften und Einstellungen erhalten.
3. Unten bei **Environment variables** wie bisher eintragen, z. B.:

   | Variable | Beispiel |
   | --- | --- |
   | `SCANNER_HOST` | `https://192.168.178.69` |
   | `CONSUME_HOST_PATH` | `/DATA/AppData/paperless/consume` |
   | `RAW_HOST_PATH` | `/DATA/Scanner_RAW` |
   | `PAPERLESS_URL` (optional) | `http://192.168.178.20:8000` |
   | `PAPERLESS_TOKEN` (optional) | Token aus Paperless → Profil → *API-Token* |

4. **„Re-pull image and redeploy“** einschalten → **Update the stack**.

Kontrolle: `http://THINKCENTRE-IP:8823/api/config` zeigt jetzt eine `version`
(der Git-Commit). In der App steht sie unter **Einstellungen → Über**.

### c) Ab jetzt: nichts mehr tun

- Jeder Push auf `main` → GitHub baut `ghcr.io/kmitulla/pdfcompress:latest`.
- **Watchtower** (zweiter Dienst im Stack, Container `pdfpresser-watchtower`)
  prüft alle 5 Minuten, lädt das neue Image und startet *nur* `pdfpresser`
  neu. Alte Images räumt er weg.
- Die App im Browser bemerkt die neue Version über den Service Worker und lädt
  sich selbst neu – aber nie, solange Dokumente in Arbeit sind (dann erscheint
  „Neue Version bereit – zum Neuladen hier tippen“).

Watchtower ist der gepflegte Fork `nickfedor/watchtower` (das Original
`containrrr/watchtower` ist seit Ende 2025 archiviert). Wer keine Automatik
will: den `watchtower`-Block aus der Compose löschen.

### Sofort aktualisieren (ohne auf Watchtower zu warten)

- **Portainer:** *Containers → pdfpresser → Recreate* → **„Re-pull image“** an.
- **Kommandozeile:** `docker compose pull && docker compose up -d`

---

## 2. Epson ET-2720 als Netzwerk-Scanner

1. Drucker ins WLAN bringen, im Router eine **feste IP** (DHCP-Reservierung) vergeben.
2. In der App: **Einstellungen → Netzwerk-Scanner → Suchen** findet das Gerät
   im Netz – **Übernehmen** tippen. (Oder die Adresse von Hand eintragen, z. B.
   `https://192.168.178.69`, und **Speichern**. Der Wert aus der
   docker-compose.yml ist dann nur noch der Standard.)
3. **Prüfen** zeigt Modell und die Auflösungen, die das Gerät wirklich kann
   (beim ET-2720: 100/200/300/600 dpi).

### Auflösung und Farbe

Das Scan-Blatt bietet nur Auflösungen an, die der Scanner meldet. Wünsche, die
das Gerät nicht kennt, werden passend umgesetzt – deshalb gibt es kein „Scanner
belegt / HTTP 409“ mehr bei 150 dpi oder S/W:

| Wahl in der App | geht an den Scanner als | Ergebnis |
| --- | --- | --- |
| 150 dpi (ältere Einstellung) | nächste unterstützte, z. B. 200 dpi | Datei heißt `…_200dpi.jpg` |
| Grau | Graustufen-JPEG | – |
| S/W | Graustufen-JPEG (1-Bit-JPEG gibt es nicht) | sauberes Schwarz-Weiß macht die Kompression („Scan S/W“) |

Hängt am Gerät noch ein alter Auftrag, räumt der Server ihn vorher ab.

### Scans laufen auf dem Server weiter

Ein Scan ist ein **Auftrag auf dem Server**: Der Server spricht den Scanner an,
wartet die Pausen ab und speichert jede Seite sofort. Du kannst die App
schließen oder das Handy sperren – der Stapel läuft weiter. Öffnest du die App
wieder, steht oben **„Scan vom … · 3 Seiten“** → **Öffnen** holt die Seiten ins
Studio (läuft er noch, kommen weitere Seiten live dazu). Erst wenn daraus ein
Dokument geworden ist, wird der Auftrag gelöscht. Auch ein Neustart des
Containers verliert keine gescannten Seiten (der Auftrag heißt dann
„unterbrochen“ und lässt sich fortsetzen).

### A4-Bereich einrichten (mit Testscan)

**Einstellungen → Netzwerk-Scanner → A4-Bereich → Einrichten …**

1. Ein A4-Blatt so auflegen, wie du immer scannst → **Testscan**.
2. Den blauen Rahmen auf die Papierkanten legen: **ziehen** verschiebt, eine
   **Ecke ziehen** skaliert. Das Seitenverhältnis 210 : 297 ist gesperrt – wer
   die Höhe ändert, ändert die Breite automatisch mit.
3. Fein: Felder X/Y/Höhe in mm oder die Pfeile (Schrittweite antippen: 0,1 /
   0,5 / 1 / 5 mm). Die **Ecken-Lupe** zeigt alle vier Ecken stark vergrößert.
4. **Speichern** – gilt ab sofort für jeden Scan.

Im Studio lässt sich jede Seite weiterhin nachziehen; dort kann man unter
**Seitenverhältnis** wählen: *Frei* (Ecken einzeln, Perspektive), *A4* oder
*Fest* (aktuelles Verhältnis bleibt).

### Mehrere Seiten (Stapel)

**Scanner** antippen → **Seiten** und **Pause** einstellen → **Scannen**. Die
Pause zum Vorlagenwechsel zählt im Studio herunter; **Stopp** beendet vorzeitig,
eingelesene Seiten bleiben. Weitere Seiten jederzeit über **„Weitere Seite →
Scanner“** im Studio.

---

## 3. Paperless anbinden

Alles lässt sich in der App unter **Einstellungen → Paperless** eintragen
(gespeichert auf dem Server, gilt für alle Geräte). Werte aus der
docker-compose.yml sind nur der Standard.

**Weg 1 – API (empfohlen):** Der Server schickt das PDF direkt an Paperless,
der Name aus der App wird der Titel. Kein gemeinsamer Ordner nötig.

1. Paperless öffnen → oben rechts dein Name → **Mein Profil** → bei
   **API-Token** auf ↻ tippen (erzeugen) → Token kopieren.
2. In der App: **Adresse** von Paperless eintragen – so, wie der *Server* sie
   erreicht, z. B. `http://192.168.178.20:8000` (nicht `localhost`, außer
   Paperless läuft im selben Container-Netz).
3. Token einfügen → **Verbindung testen** („Verbunden mit Paperless 2.x · N
   Dokumente“) → **Speichern**.

Der Token wird nie wieder angezeigt, nur „gespeichert“. Zum Entfernen den
Papierkorb neben dem Feld tippen.

**Weg 2 – consume-Ordner:** Das PDF wird in den Ordner gelegt, den Paperless
überwacht. In der App steht der Pfad **im Container** (Standard
`/data/consume`). Damit die Datei auf dem ThinkCentre ankommt, muss der Ordner
in der Compose eingebunden sein, z. B. `/DATA/paperless/consume:/data/consume`.
Unterordner davon (`/data/consume/scans`) gehen ohne Änderung; die App zeigt die
eingebundenen Ordner an. Geschrieben wird atomar (`.name.part` → umbenennen),
gleichnamige Dateien werden nicht überschrieben.

Sind beide eingerichtet, wird die API benutzt; ist sie nicht erreichbar, landet
die Datei im Ordner (die App meldet das).

**Ohne Extra-Tipp:** *Einstellungen → Automatik → Sofort komprimieren* und
*Danach an Paperless senden* einschalten – dann reicht Scannen/Fotografieren.

---

## 4. Dokumente auf allen Geräten

Alles, was du hinzufügst oder scannst, liegt auch auf dem Server (im Volume
`pdfpresser_data`, Ordner `docs/`): Original, fertiges PDF, Profil, Name und
„an Paperless gesendet“. Am iPhone scannen, am Laptop komprimieren oder
bearbeiten – die Liste gleicht sich beim Öffnen und alle 15 Sekunden ab.
Gelöschte Dokumente verschwinden überall. Ohne Netz arbeitet die App mit ihrer
lokalen Kopie weiter und gleicht später ab (bei gleichzeitigen Änderungen
gewinnt die jüngere).

## 5. Am Handy

1. `http://THINKCENTRE-IP:8823` öffnen, im Browsermenü **„Zum Home-Bildschirm“**.
2. Das große **+** unten: **Foto aufnehmen** (öffnet die Kamera-App – Fokus,
   HDR, Blitz wie gewohnt; funktioniert auch ohne HTTPS), **Fotos & Dateien**
   oder **Netzwerk-Scanner**.
3. Im Scan-Studio Seiten prüfen → **Fertig**. Das Dokument bekommt das
   Standardprofil für Scans (Werkseinstellung: *Scan S/W* + Texterkennung).
4. Karte antippen → **Komprimieren** → **An Paperless** / **Teilen** /
   **Öffnen** (im Browser) / **Laden**.

Profile und Optionen lassen sich pro Dokument ändern; **„Größen schätzen“**
zeigt vorher für jedes Profil die Dateigröße, **Vorschau** das Aussehen.
„Als Standard merken“ übernimmt die Wahl für künftige Dokumente.

---

## 6. Sammelordner („Paperless Prepare“)

Rohscans erst parken, dann gesammelt übernehmen:

- `RAW_HOST_PATH` z. B. auf `/DATA/Scanner_RAW` – dort kannst du auch vom
  Rechner aus Dateien hineinlegen.
- **Scannen** im Scanner-Blatt mit Ziel **Sammelordner** legt die Rohbilder
  unverändert ab (Auflösung steht im Dateinamen).
- Auswahl → **Als Dokument öffnen**: nur Bilder → Scan-Studio (mit festem
  A4-Ausschnitt); gemischt mit PDFs → direkt ein Dokument.
- Nach **An Paperless** fragt die App, ob die Rohdateien gelöscht werden sollen.

---

## 7. Wo läuft die Rechenarbeit?

| Aufgabe | läuft auf |
| --- | --- |
| Zuschnitt, Kompression, Vorschau | **Handy/Laptop** (Browser) |
| Texterkennung (OCR) | **ThinkCentre** (nativer Tesseract, mehrere Seiten parallel) – fällt er aus, rechnet der Browser |
| Scanner ansprechen (Scan-Aufträge), Dateien ablegen, Paperless-Upload, Profil & Einstellungen speichern | ThinkCentre |

Die Texterkennung lief früher im Browser – am iPhone dauert das pro Seite
leicht eine Minute und länger. Jetzt schickt die App jede Seite kurz an deinen
Server, der sie in wenigen Sekunden erkennt (nur an deinen eigenen Server,
nirgendwo sonst hin). Abschalten: *Einstellungen → Texterkennung auf dem
Server*.

---

## Fehlersuche

| Symptom | Lösung |
| --- | --- |
| Update kommt nicht an | *Actions* auf GitHub grün? Package **public**? `docker logs pdfpresser-watchtower` ansehen. Sofort: Container *Recreate* mit „Re-pull image“. |
| `pull access denied` / `unauthorized` für ghcr.io | Package ist noch privat → auf Public stellen (Abschnitt 1a) oder Registry in Portainer hinterlegen. |
| Scanner „nicht erreichbar“ | In der App **Suchen** oder Adresse mit `https://` versuchen; `curl -sk https://IP/eSCL/ScannerCapabilities` vom ThinkCentre. |
| Scan endet mit HTTP 503/409 | Gerät noch belegt – wird automatisch abgeräumt und wiederholt; sonst Drucker kurz aus/an. |
| A4-Ausschnitt sitzt 1–2 mm daneben | *Einstellungen → Netzwerk-Scanner → A4-Bereich → Einrichten* mit Testscan. |
| Paperless: „lehnt den API-Token ab“ | Token in Paperless neu erzeugen und in der App eintragen. |
| Paperless: „nicht erreichbar“ | Adresse aus Sicht des Servers prüfen (IP statt `localhost`, Port 8000). |
| EACCES beim Speichern | Ordnerrechte; `user: "0:0"` steht bereits in der Compose. |
| CIFS-Mount „invalid argument“ | NAS-Passwort enthält ein Komma – ändern. |
| Unterschriften nach Update weg | Stack-Name geändert oder Volume `pdfpresser_data` gelöscht. |
| Browser zeigt alte Version | Seite neu laden; am iPhone die Web-App einmal schließen und öffnen. |

## Lokal ausprobieren

```bash
SCANNER_HOST=https://192.168.178.69 CONSUME_DIR=./consume RAW_DIR=./raw npm start
# → http://localhost:8823
```
