# PDF Presser – Web-App + Scanner-/Speicher-Backend in einem schlanken Image.
# Kein Build-Schritt nötig: reines Node ohne externe Abhängigkeiten.
FROM node:20-alpine

# Nicht als root laufen.
WORKDIR /app

# Nur die für den Betrieb nötigen Dateien kopieren (Tests/Doku bleiben außen vor,
# siehe .dockerignore).
COPY . /app

ENV PORT=8823 \
    NODE_ENV=production

EXPOSE 8823

# Einfacher Healthcheck über den Config-Endpunkt.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8823/api/config >/dev/null 2>&1 || exit 1

USER node
CMD ["node", "server/index.mjs"]
