# TabCrew Online relay. Build from the repository root:
#   docker build -f relay/Dockerfile -t tabcrew-relay .
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY daemon/package.json daemon/
COPY relay/package.json relay/
COPY cli/package.json cli/
COPY extension/package.json extension/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY shared shared
COPY daemon daemon
COPY relay relay
RUN npm run build -w shared && npm run build -w daemon && npm run build -w relay

FROM node:22-alpine
ENV NODE_ENV=production RELAY_PORT=8790
WORKDIR /app
# Production dependencies only, from the same lockfile (workspace packages are linked below).
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY daemon/package.json daemon/
COPY relay/package.json relay/
COPY cli/package.json cli/
COPY extension/package.json extension/
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/daemon/dist daemon/dist
COPY --from=build /src/relay/dist relay/dist
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null || exit 1
CMD ["node", "relay/dist/main.js"]
