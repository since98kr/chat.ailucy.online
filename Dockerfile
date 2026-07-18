FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run test \
  && npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CHAT_API_PORT=4174 \
    CHAT_DB_PATH=/data/chat-v2.sqlite \
    CHAT_ARTIFACT_ROOT=/data/artifacts \
    CHAT_BACKUP_ROOT=/data/backups \
    CHAT_BACKUP_RETENTION=10 \
    CHAT_WEB_ROOT=/app/dist

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

RUN mkdir -p /data/artifacts /data/backups \
  && chown -R node:node /app /data

USER node

EXPOSE 4174
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4174/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist-server/runtime.js"]
