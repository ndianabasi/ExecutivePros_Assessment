FROM node:24.1.0-alpine3.21@sha256:dfea0736e82fef246aba86b2082a5e86c4825470302692b841d097dd61253b79 AS build

RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /workspace
COPY package.json yarn.lock .yarnrc.yml ./
COPY services/api/package.json services/api/package.json
COPY services/queue/package.json services/queue/package.json
COPY services/provider/package.json services/provider/package.json
COPY services/api-docs/package.json services/api-docs/package.json
COPY services/frontend/package.json services/frontend/package.json
RUN corepack yarn install --immutable
COPY services/api services/api
RUN corepack yarn workspace @executivepros/api build && \
    corepack yarn workspaces focus @executivepros/api --production

FROM node:24.1.0-alpine3.21@sha256:dfea0736e82fef246aba86b2082a5e86c4825470302692b841d097dd61253b79 AS runtime

RUN apk add --no-cache ca-certificates libstdc++ tzdata && \
    addgroup -S -g 10001 api && \
    adduser -S -D -H -u 10001 -G api api && \
    mkdir -p /data && chown 10001:10001 /data
WORKDIR /workspace/services/api
COPY --from=build /workspace/package.json /workspace/package.json
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/services/api/package.json ./package.json
COPY --from=build --chown=10001:10001 /workspace/services/api/dist/src ./dist/src
COPY --from=build --chown=10001:10001 /workspace/services/api/dist/bin ./dist/bin
COPY --from=build --chown=10001:10001 /workspace/services/api/dist/knexfile.js ./dist/knexfile.js
COPY --from=build --chown=10001:10001 /workspace/services/api/dist/database ./dist/database
ENV NODE_ENV=production PORT=3000 API_DB_PATH=/data/api.db
USER 10001:10001
EXPOSE 3000/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/src/server.js"]
