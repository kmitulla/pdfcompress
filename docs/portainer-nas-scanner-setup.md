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

## Fehlersuche

| Symptom | Ursache / Lösung |
| --- | --- |
| Kachel „Netzwerk-Scanner" fehlt | `SCANNER_HOST` nicht gesetzt oder App über GitHub Pages statt über den Container geöffnet. `/api/config` prüfen. |
| `scanner status` → `ok:false` | Drucker aus/anderes Netz, falsche IP, oder eSCL nur über HTTPS → `SCANNER_HOST=https://IP`. |
| Scan bricht mit HTTP 503/409 ab | Drucker im Energiesparmodus oder belegt – kurz warten, erneut. |
| Button „An Paperless" fehlt | `CONSUME_DIR`/Volume nicht gemountet. `/api/config` → `consume` muss `true` sein. |
| Paperless sieht die Datei nicht | Mountet der Container denselben Ordner, den Paperless überwacht? Rechte (uid/gid) des NAS-Mounts prüfen. |
| Kamera-Scan am Handy geht nicht | http ist kein sicherer Kontext → HTTPS voranstellen (siehe oben). |

---

## Lokal ausprobieren (ohne Docker)

```bash
SCANNER_HOST=192.168.1.50 CONSUME_DIR=./consume node server/index.mjs
# → http://localhost:8823
```

Ohne gesetzte Variablen läuft die App wie gehabt als reines Frontend; die
Scanner-/Paperless-Funktionen bleiben dann einfach ausgeblendet.
