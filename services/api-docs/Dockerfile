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
COPY services/api-docs services/api-docs
RUN corepack yarn workspace @executivepros/api-docs build && corepack yarn workspaces focus @executivepros/api-docs --production

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
RUN apk add --no-cache nginx=1.30.6-r0 nodejs=24.22.3-r0 && \
    addgroup -S -g 10004 docs && adduser -S -D -H -u 10004 -G docs docs && \
    mkdir -p /usr/share/nginx/html /tmp && chown -R 10004:10004 /usr/share/nginx/html /tmp
COPY --from=build --chown=10004:10004 /workspace/services/api-docs/build/ /usr/share/nginx/html/
COPY --chown=10004:10004 services/api-docs/scripts/startup.mjs /opt/docs/startup.mjs
USER 10004:10004
EXPOSE 8080/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health/ready"]
CMD ["sh", "-c", "node /opt/docs/startup.mjs && exec nginx -e stderr -c /tmp/nginx.conf"]
