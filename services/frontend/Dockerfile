FROM node:24.1.0-alpine3.21@sha256:dfea0736e82fef246aba86b2082a5e86c4825470302692b841d097dd61253b79 AS build
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /workspace
COPY package.json yarn.lock .yarnrc.yml ./
COPY services/api/package.json services/api/package.json
COPY services/queue/package.json services/queue/package.json
COPY services/provider/package.json services/provider/package.json
COPY services/api-docs/package.json services/api-docs/package.json
COPY services/frontend/package.json services/frontend/package.json
RUN corepack yarn install --immutable
COPY services/frontend services/frontend
RUN corepack yarn workspace @executivepros/frontend build

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
RUN apk add --no-cache nginx=1.30.6-r0 nodejs=24.22.3-r0 && \
    addgroup -S -g 10005 frontend && adduser -S -D -H -u 10005 -G frontend frontend && \
    mkdir -p /usr/share/nginx/html /tmp && chown -R 10005:10005 /usr/share/nginx/html /tmp
COPY --from=build --chown=10005:10005 /workspace/services/frontend/build/ /usr/share/nginx/html/
COPY --chown=10005:10005 services/frontend/scripts/startup.mjs /opt/frontend/startup.mjs
ENV API_ORIGIN=http://127.0.0.1:18083 PROVIDER_ORIGIN=http://127.0.0.1:18082 DOCS_ORIGIN=http://127.0.0.1:18081 MAILPIT_ORIGIN=http://127.0.0.1:18025
USER 10005:10005
EXPOSE 8080/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health/ready"]
CMD ["sh", "-c", "node /opt/frontend/startup.mjs && exec nginx -e stderr -c /tmp/nginx.conf"]
