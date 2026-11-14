# Image de l'appli, construite sur le Pi (arm64). Node 26 exécute le TypeScript tel quel : aucune étape de build.
# node:sqlite est intégré à Node : aucun module natif, donc aucun outil de compilation.
FROM node:26.13.1-trixie-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/app.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# Fichiers de l'appli à root (lecture seule pour node) ; /data accessible à node si aucun volume n'y est monté.
RUN mkdir /data && chown node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/server.ts"]
