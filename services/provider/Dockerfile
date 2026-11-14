FROM node:24.1.0-alpine3.21@sha256:dfea0736e82fef246aba86b2082a5e86c4825470302692b841d097dd61253b79 AS build

RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /workspace
COPY package.json yarn.lock .yarnrc.yml ./
COPY services/api/package.json services/api/package.json
COPY services/queue/package.json services/queue/package.json
COPY services/provider/package.json services/provider/package.json
COPY services/api-docs/package.json services/api-docs/package.json
RUN corepack yarn install --immutable
COPY services/provider services/provider
RUN corepack yarn workspace @executivepros/provider build && \
    corepack yarn workspaces focus @executivepros/provider --production

FROM node:24.1.0-alpine3.21@sha256:dfea0736e82fef246aba86b2082a5e86c4825470302692b841d097dd61253b79 AS runtime

RUN apk add --no-cache ca-certificates libstdc++ tzdata && \
    addgroup -S -g 10003 provider && \
    adduser -S -D -H -u 10003 -G provider provider && \
    mkdir -p /data && chown 10003:10003 /data
WORKDIR /workspace
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/provider/package.json ./services/provider/package.json
COPY --from=build --chown=10003:10003 /workspace/services/provider/dist ./services/provider/dist
WORKDIR /workspace/services/provider
ENV NODE_ENV=production PORT=3000 PROVIDER_DB_PATH=/data/payment_provider.db
USER 10003:10003
EXPOSE 3000/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/src/server.js"]
