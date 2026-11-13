# Mock Email Service Implementation Checklist

Source of truth: [Mock_Email_Service_Implementation.md](Mock_Email_Service_Implementation.md). Check a task only after implementation or the named gate has been verified. Leave failed, skipped, or blocked gates unchecked and record the result. This list covers the Mock Email Service and its integration boundaries; it does not assign API, queue, or frontend implementation to this service.

## 1. Service boundary and image

- [x] Run exactly one Mailpit container to receive queue SMTP messages and expose the inbox UI, without custom business endpoints or a separate application server.
- [ ] Keep notification decisions, recipients, and rendered content in the API Service, and job persistence/retries/SMTP sending in the Message Queue Service.
- [x] Build Mailpit `v1.33.1` from upstream source in this service's single multi-stage Dockerfile; do not use a prebuilt Mailpit runtime image.
- [x] Pin and verify the Mailpit source revision or archive checksum in build inputs.
- [x] Use `alpine:3.24.4` in both build and runtime stages and record the Alpine and final-image digests in `AGENTS.md`.
- [x] Build the upstream UI with its committed npm lockfile and packaging script; compile the versioned Go binary with `CGO_ENABLED=0`.
- [x] Generate or preserve the upstream release's required license notices.
- [x] Keep Go, Node, npm, Git, and other build tools out of the final image.
- [x] Run the Mailpit binary as the main process under a non-root user; make only `/data` writable where practical.
- [x] Expose container SMTP port `1025` and UI/API port `8025`; do not enable or expose POP3 port `1110`.

## 2. Compose configuration, access, and safety

- [ ] Attach Mailpit and the queue to the trusted Compose network; set the queue's Mailpit destination to `SMTP_HOST=mailpit`, `SMTP_PORT=1025`.
- [ ] Keep SMTP plain and unauthenticated on that network; publish no SMTP host port.
- [x] Set `MP_SMTP_BIND_ADDR=0.0.0.0:1025` and `MP_SMTP_MAX_RECIPIENTS=1`.
- [x] Set `MP_UI_BIND_ADDR=0.0.0.0:8025` and publish only `127.0.0.1:18025:8025` on the host.
- [x] Set `MP_ALLOWED_HOSTS=mailpit` and verify host-local loopback access works.
- [ ] Set frontend `MAILPIT_ORIGIN=http://127.0.0.1:18025`; verify it is a browser URL, not a Compose hostname.
- [ ] Keep the frontend integration to a new-tab Mailpit UI link; add no embedded UI or browser Mailpit API calls.
- [ ] Keep SMTP/UI auth and TLS unset only for the agreed host-local trusted demo.
- [x] Leave `MP_API_CORS`, SMTP relay, SMTP forwarding, Send API auth overrides, and POP3 credentials unset; configure no real-mail destination.
- [x] Set `MP_DISABLE_VERSION_CHECK=true` and `MP_BLOCK_REMOTE_CSS_AND_FONTS=true`.
- [x] Keep `MP_ENABLE_CHAOS=false`, leave `MP_CHAOS_TRIGGERS` unset, and add no other SMTP fault injection to normal Mailpit deployment.
- [ ] Do not enable Mailpit options that fetch internal URLs or bypass TLS verification.
- [ ] Keep captured message bodies out of application logs and avoid verbose Mailpit logging.

## 3. Inbox persistence and lifecycle

- [x] Mount a named local Docker volume at `/data` and set `MP_DATABASE=/data/mailpit.db`; do not use Mailpit's temporary database or a shared/network filesystem.
- [x] Verify the non-root runtime user can create and update the SQLite database and its WAL files in the mounted volume.
- [x] Set `MP_MAX_MESSAGES=0` and leave `MP_MAX_AGE` unset so no automatic count/age pruning removes demo evidence.
- [x] Set `MP_MAX_MESSAGE_SIZE=1` MB and `MP_IGNORE_DUPLICATE_IDS=false`.
- [x] Preserve separate Mailpit messages for repeated SMTP deliveries, including repeated Message-IDs; verified using two direct SMTP messages in an isolated disposable volume.
- [ ] Keep Mailpit's local SQLite/WAL behavior and schema ownership with Mailpit; add no Knex tables or `down` migration.
- [ ] Before an upgrade, stop queue worker/traffic and Mailpit, take a consistent cold backup including database/WAL files, then start the replacement image and inspect the inbox.
- [ ] Inspect volume free space and mailbox growth during the demo because pruning is disabled.
- [ ] Define an explicit reset for an identified disposable Mailpit volume only; do not reset API or queue volumes.

## 4. Health, observability, and failure behavior

- [x] Configure a container-internal health check using Mailpit `/livez` and `/readyz`; do not depend on the host-published port.
- [ ] Verify SMTP connectivity from the queue network separately from HTTP readiness.
- [ ] Send Mailpit process output to container stdout/stderr and retain Compose logs for diagnosis without message-body logging.
- [ ] Treat successful SMTP acceptance as capture in the demo inbox, not delivery to a real mailbox or proof that a user read it.
- [ ] Ensure unwritable/full volume or Mailpit outage produces an observable readiness/startup or SMTP failure; do not claim capture without mailbox evidence.
- [ ] Verify that restart with the same volume preserves messages and that queue retry/dead-job behavior remains the queue's responsibility. Persistence passed in a disposable volume; queue retry behavior awaits the queue service.

## 5. Test gates — check only after passing

- [x] **Source/build:** pinned source and Alpine versions verify; UI and Go builds reproduce; license notices exist; image starts non-root without build tools (local arm64 build; digests recorded in `AGENTS.md`).
- [ ] **Configuration/exposure:** Compose has one container, writable named local volume, internal-only SMTP, loopback-only UI, host allowlist, no browser CORS, no relay/forward/POP3/Chaos, and no baked-in secrets.
- [ ] **Health:** `/livez` and `/readyz` return `200` internally; an unreadable/unwritable database blocks readiness or startup; queue-network SMTP connection works.
- [ ] **SMTP capture:** a real queue email appears in Mailpit API/UI with correct sender, single recipient, subject, text, and optional HTML.
- [ ] **Duplicate evidence:** two queue deliveries remain two visible messages, including a repeated Message-ID. Direct SMTP duplicate capture passed; queue-driven delivery awaits the queue service.
- [x] **Retention/restart:** messages survive Mailpit restart; configuration disables count/age pruning; an explicit disposable-test-volume reset empties only the Mailpit inbox.
- [ ] **Capacity/error:** an unwritable or full volume produces visible readiness/startup or SMTP failure and useful body-free logs; no unconfirmed capture is reported.
- [ ] **Browser access:** a real browser follows the frontend link to the host-local UI; UI/API work on loopback, SMTP is unpublished, and UI access from a non-loopback host interface fails.
- [ ] **Compose end-to-end:** API, queue, and Mailpit show expected user/admin success and failure notifications in the inbox without changing payment state because of mail behavior.
- [ ] **Compose outage/recovery:** Mailpit outage is visible to the queue; after restoration an eligible retried job reaches Mailpit, with job state, mailbox, and logs checked.
- [ ] Verify queue SMTP 4xx/5xx classification against a separate test SMTP server; do not enable Mailpit Chaos to satisfy that queue-owned test.
- [ ] Use disposable mailboxes/volumes for automated tests; never clear a developer's persistent inbox.
- [ ] Record every test gate, command, result, and skipped or blocked suite; do not count a build alone as deployment acceptance.

## 6. Deployment gates — complete in order

- [x] **D1 Artifact:** build from verified Mailpit `v1.33.1` source and exact `alpine:3.24.4` bases; record revision/checksum and local arm64 image digest in `AGENTS.md`.
- [x] **D1 Runtime:** verify non-root user, writable `/data`, required license notices, image smoke start, and source/build.
- [ ] **D2 Configuration:** confirm disabled pruning/relay/forwarding/Chaos, host-loopback UI, internal-only SMTP, allowed host, queue SMTP address, and frontend browser URL.
- [ ] **D2 Storage:** confirm one container, volume ownership/write access/free space, and consistent backup of an existing inbox before upgrade.
- [ ] **D3 Readiness:** require healthy internal `/livez` and `/readyz`, host-local UI/API access, and SMTP connectivity from the queue network.
- [ ] **D4 Functional smoke:** send a real queue email; inspect sender, recipient, subject, text, and HTML; verify frontend link and persistence after restart.
- [ ] **D5 Recovery smoke:** interrupt and restore Mailpit during a disposable flow; observe queue state and eligible redelivery, distinct duplicate messages, and unchanged payment state.
- [ ] **D6 Operations:** document start/stop, host-local inbox URL, Compose SMTP address, health checks, logs, volume backup/restore, capacity monitoring, tests, and explicit disposable-volume reset in README.
- [ ] Record each deployment gate result and any unrun check before declaring acceptance.
- [ ] On failed rollout, preserve volume/logs; use the previous image only if database-compatible, otherwise restore a verified pre-upgrade backup into an isolated volume.
- [ ] Preserve API/queue volumes during Mailpit rollback and never expose the UI beyond host loopback.
