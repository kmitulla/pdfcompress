# PDF Presser auf dem ThinkCentre (ZimaOS/Portainer): Scanner, Paperless, Auto-Update

> Am Handy die App öffnen → fotografieren, hochladen oder am **Epson ET-2720**
> scannen → automatisch exakt **DIN A4** → komprimieren & Texterkennung →
> **an Paperless**. Neue Versionen spielt der Server von selbst ein.

```
 Handy/Laptop (Browser) ──HTTP──► pdfpresser-Container (ThinkCentre)
   │  Oberfläche, Zuschnitt, Kompression und OCR rechnen im Browser
   ├─ /api/scanner/scan ─► eSCL ─► Epson ET-2720 (LAN)
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
2. Test vom ThinkCentre:
   ```bash
   curl -sk https://192.168.178.69/eSCL/ScannerCapabilities | head -c 300
   ```
   Kommt XML mit `MakeAndModel`, passt es. Der ET-2720 spricht eSCL meist nur
   über **HTTPS** → `SCANNER_HOST=https://…`.
3. In der App: **Einstellungen → Netzwerk-Scanner → Prüfen** zeigt das Modell.

### Fester A4-Ausschnitt auf der Glasfläche

Die Glasfläche des ET-2720 ist 215,9 × 297 mm – also 6 mm breiter als A4.
Die App schneidet jede Seite **immer exakt 210 × 297 mm ab der Anlegeecke**
aus (aus Pixelgröße und Scanauflösung berechnet, keine wackelige
Kantenerkennung). Das Ergebnis ist eine exakte A4-Seite.

- **Einstellungen → Netzwerk-Scanner → Anlegeecke:** wo die Vorlage anliegt
  (Standard: oben links – beim Epson die Ecke mit dem Pfeil).
- **Feinjustage X/Y (mm):** falls dein Gerät den Nullpunkt minimal versetzt.
  + verschiebt den Ausschnitt nach rechts bzw. unten.
- Im Studio lässt sich jede Seite trotzdem von Hand nachziehen; **„A4-Fläche“**
  setzt den festen Ausschnitt zurück.

### Mehrere Seiten (Stapel)

**Scanner** antippen → im Blatt **Seiten** und **Pause** einstellen →
**Scannen**. Die App scannt die Seiten nacheinander, zählt die Pause herunter
(„nächste in 6 s · Vorlage wechseln“) und legt jede Seite gleich mit
A4-Zuschnitt ab. **Stopp** beendet vorzeitig, eingelesene Seiten bleiben.
Weitere Seiten jederzeit über die Kachel **„Weitere Seite“** im Studio.

Damit das Handy währenddessen nicht einschläft, spielt die App eine stille
Tonspur und hält – nur über HTTPS – zusätzlich den Bildschirm wach.

---

## 3. Paperless anbinden

**Weg 1 – API (empfohlen):** `PAPERLESS_URL` und `PAPERLESS_TOKEN` setzen.
Der Name des Dokuments in der App wird zum Titel in Paperless. Kein
gemeinsamer Ordner nötig.

**Weg 2 – consume-Ordner:** `CONSUME_HOST_PATH` auf den Ordner zeigen lassen,
den Paperless überwacht. Geschrieben wird atomar (`.name.part` → umbenennen),
gleichnamige Dateien werden nicht überschrieben.

Sind beide gesetzt, wird die API benutzt; ist sie nicht erreichbar, landet die
Datei im Ordner (die App meldet das).

**Ohne Extra-Tipp:** *Einstellungen → Automatik → Sofort komprimieren* und
*Danach an Paperless senden* einschalten – dann reicht Scannen/Fotografieren.

---

## 4. Am Handy

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

## 5. Sammelordner („Paperless Prepare“)

Rohscans erst parken, dann gesammelt übernehmen:

- `RAW_HOST_PATH` z. B. auf `/DATA/Scanner_RAW` – dort kannst du auch vom
  Rechner aus Dateien hineinlegen.
- **Scannen** im Scanner-Blatt mit Ziel **Sammelordner** legt die Rohbilder
  unverändert ab (Auflösung steht im Dateinamen).
- Auswahl → **Als Dokument öffnen**: nur Bilder → Scan-Studio (mit festem
  A4-Ausschnitt); gemischt mit PDFs → direkt ein Dokument.
- Nach **An Paperless** fragt die App, ob die Rohdateien gelöscht werden sollen.

---

## 6. Wo läuft die Rechenarbeit?

| Aufgabe | läuft auf |
| --- | --- |
| Zuschnitt, Kompression, Texterkennung, Vorschau | **Handy/Laptop** (Browser) |
| Scanner ansprechen, Dateien ablegen, Paperless-Upload, Profil speichern | ThinkCentre |

Das ThinkCentre bleibt dadurch praktisch unbelastet. Die Texterkennung nutzt am
Rechner zwei Worker parallel, am Handy einen.

---

## Fehlersuche

| Symptom | Lösung |
| --- | --- |
| Update kommt nicht an | *Actions* auf GitHub grün? Package **public**? `docker logs pdfpresser-watchtower` ansehen. Sofort: Container *Recreate* mit „Re-pull image“. |
| `pull access denied` / `unauthorized` für ghcr.io | Package ist noch privat → auf Public stellen (Abschnitt 1a) oder Registry in Portainer hinterlegen. |
| Scanner „nicht erreichbar“ | `SCANNER_HOST` mit `https://` versuchen; `curl -sk https://IP/eSCL/ScannerCapabilities` vom ThinkCentre. |
| Scan endet mit HTTP 503/409 | Gerät noch belegt – wird automatisch wiederholt; sonst Drucker kurz aus/an. |
| A4-Ausschnitt sitzt 1–2 mm daneben | *Einstellungen → Netzwerk-Scanner → Feinjustage* in mm. |
| Paperless: „API-Token prüfen“ | Token in Paperless neu erzeugen, `PAPERLESS_TOKEN` setzen, Stack aktualisieren. |
| EACCES beim Speichern | Ordnerrechte; `user: "0:0"` steht bereits in der Compose. |
| CIFS-Mount „invalid argument“ | NAS-Passwort enthält ein Komma – ändern. |
| Unterschriften nach Update weg | Stack-Name geändert oder Volume `pdfpresser_data` gelöscht. |
| Browser zeigt alte Version | Seite neu laden; am iPhone die Web-App einmal schließen und öffnen. |

## Lokal ausprobieren

```bash
SCANNER_HOST=https://192.168.178.69 CONSUME_DIR=./consume RAW_DIR=./raw npm start
# → http://localhost:8823
```
