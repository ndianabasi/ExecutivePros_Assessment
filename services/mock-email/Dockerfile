FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS builder

ARG MAILPIT_VERSION=v1.33.1
ARG MAILPIT_COMMIT=3bc38efc5c4687659b9099eb2c8d8f6e76113f11

RUN apk add --no-cache ca-certificates git go npm
WORKDIR /src
RUN git init && \
    git remote add origin https://github.com/axllent/mailpit.git && \
    git fetch --depth=1 origin "refs/tags/${MAILPIT_VERSION}:refs/tags/${MAILPIT_VERSION}" && \
    test "$(git rev-parse "${MAILPIT_VERSION}^{commit}")" = "${MAILPIT_COMMIT}" && \
    git checkout --detach "${MAILPIT_COMMIT}"

RUN npm ci && npm run package && \
    go install github.com/google/go-licenses/v2@v2.0.1 && \
    "$(go env GOPATH)/bin/go-licenses" report ./... --template .github/third-party-licenses.tpl \
      --ignore github.com/axllent/mailpit > internal/licenses/third-party.txt && \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X github.com/axllent/mailpit/config.Version=${MAILPIT_VERSION}" \
      -o /mailpit

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime

LABEL org.opencontainers.image.title="Mailpit" \
  org.opencontainers.image.description="Host-local SMTP capture inbox for the assessment demo" \
  org.opencontainers.image.source="https://github.com/axllent/mailpit" \
  org.opencontainers.image.version="v1.33.1" \
  org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S -g 10001 mailpit && \
    adduser -S -D -H -u 10001 -G mailpit mailpit && \
    mkdir -p /data && chown 10001:10001 /data

COPY --from=builder --chown=10001:10001 /mailpit /mailpit
COPY --from=builder --chown=10001:10001 /src/LICENSE /licenses/mailpit-LICENSE
COPY --from=builder --chown=10001:10001 /src/internal/licenses/third-party.txt /licenses/third-party.txt

ENV MP_DATABASE=/data/mailpit.db \
    MP_MAX_MESSAGES=0 \
    MP_MAX_MESSAGE_SIZE=1 \
    MP_IGNORE_DUPLICATE_IDS=false \
    MP_SMTP_BIND_ADDR=0.0.0.0:1025 \
    MP_SMTP_MAX_RECIPIENTS=1 \
    MP_UI_BIND_ADDR=0.0.0.0:8025 \
    MP_ALLOWED_HOSTS=mailpit \
    MP_DISABLE_VERSION_CHECK=true \
    MP_BLOCK_REMOTE_CSS_AND_FONTS=true \
    MP_ENABLE_CHAOS=false

USER 10001:10001
WORKDIR /data
EXPOSE 1025/tcp 8025/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["/mailpit", "readyz"]
ENTRYPOINT ["/mailpit"]
