# PDF Presser – Web-App + Scanner-/Paperless-Backend in einem schlanken Image.
# Kein Build-Schritt nötig: reines Node ohne externe Abhängigkeiten.
FROM node:22-alpine

WORKDIR /app

# Texterkennung auf dem Server: am Handy ist Tesseract im Browser sehr langsam,
# der native Tesseract schafft eine Seite in wenigen Sekunden.
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-deu tesseract-ocr-data-eng

# Nur die für den Betrieb nötigen Dateien (siehe .dockerignore)
COPY index.html manifest.webmanifest sw.js package.json ./
COPY css ./css
COPY js ./js
COPY icons ./icons
COPY vendor ./vendor
COPY server ./server

# Versionskennung (setzt der GitHub-Workflow auf den Commit). Ohne Angabe
# berechnet der Server sie aus dem Inhalt der App.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION} \
    PORT=8823 \
    NODE_ENV=production

LABEL org.opencontainers.image.source="https://github.com/kmitulla/pdfcompress" \
      org.opencontainers.image.description="PDF Presser – PDFs & Scans lokal verkleinern, DIN A4, OCR, an Paperless senden" \
      org.opencontainers.image.licenses="ISC"

EXPOSE 8823

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8823/api/config >/dev/null 2>&1 || exit 1

USER node
CMD ["node", "server/index.mjs"]
