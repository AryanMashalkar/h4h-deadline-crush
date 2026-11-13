# One image: API + worker + built React UI. poppler-utils renders PDF previews.
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache poppler-utils
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/migrations ./migrations
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist /app/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/src/server.js"]
