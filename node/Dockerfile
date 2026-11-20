FROM node:20-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Xeros59/Drive---Ticeconnect" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Outils de compilation au cas où better-sqlite3 n'a pas de binaire précompilé pour la plateforme
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force

COPY server ./server
COPY public ./public
COPY templates ./templates

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
