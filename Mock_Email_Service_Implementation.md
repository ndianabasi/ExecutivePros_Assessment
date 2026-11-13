# Mock Email Service Implementation Document

## 1. Purpose and boundary

This document specifies only the **Mock Email Service** in [System_Architecture.md](System_Architecture.md). Run [Mailpit](https://mailpit.axllent.org/docs/) to accept email over SMTP from the Message Queue Service and make captured messages readable in its web UI. The API Service owns notification decisions, recipients, and rendered content; the queue owns durable jobs, retries, and SMTP sending. Mailpit neither decides when to notify nor changes payment state. No email is delivered to an external mailbox.

The target is a trusted, host-local assessment demo with one Mailpit container. The frontend opens the Mailpit UI in a new tab through its configured `MAILPIT_ORIGIN`; it does not embed the UI or call Mailpit's API. Mailpit's own SMTP, UI, health endpoints, and read API suffice; add no custom application server or business endpoint.

### Settled decisions

| Area | Decision |
| --- | --- |
| Build | Compile an exact Mailpit release from upstream source in this service's Dockerfile; use patch-pinned Alpine bases in build and runtime stages. Do not use a prebuilt Mailpit runtime image. |
| Capture | Queue-to-Mailpit SMTP is plain and unauthenticated on the isolated Compose network. Do not publish SMTP to the host. |
| Browser access | Publish the Mailpit UI/API on host loopback only. The frontend link points to the browser-reachable host URL, not the Compose hostname. |
| Storage | Persist the inbox in a named local Docker volume. Disable automatic count- and age-based pruning; keep messages until an explicit disposable-volume reset. |
| Duplicate delivery | Preserve separate captured messages when the queue sends duplicates; do not enable Mailpit's duplicate-Message-ID suppression. |
| Failure simulation | Leave Mailpit Chaos disabled. Queue SMTP 4xx/5xx classification tests use a separate test SMTP server; the normal Mailpit service is not an error-injection tool. |
| Real delivery | Do not configure SMTP relay, SMTP forwarding, or POP3. |

## 2. Image build and runtime layout

Create one multi-stage Dockerfile for this service. As of this plan, use Mailpit `v1.33.1` and `alpine:3.24.4` for both build and runtime stages. Pin the source release to its verified commit or archive checksum in build inputs, and record the Alpine and built-image digests in the release evidence. Build the upstream UI with its committed npm lockfile (`npm ci` and the release's packaging script), then build the Go binary with `CGO_ENABLED=0` and release version metadata. Follow the [upstream source requirements](https://mailpit.axllent.org/docs/install/source/) and [Dockerfile build sequence](https://github.com/axllent/mailpit/blob/develop/Dockerfile), including generation or preservation of the license notices needed by the release. Build dependencies stay out of the runtime stage.

The runtime stage contains the Mailpit binary, required runtime assets/licenses, and a non-root service user. Create `/data` with ownership that permits this user to write the mounted named volume; keep the rest of the filesystem read-only where practical. Run Mailpit as the container's main process so Compose signals reach it. Expose container ports `1025` (SMTP) and `8025` (web UI/API); do not enable or expose POP3 port `1110`.

## 3. Configuration, network, and storage

Use these fixed demo settings, with no implicit fallback to a temporary inbox:

| Setting | Value and purpose |
| --- | --- |
| `MP_DATABASE` | `/data/mailpit.db` on a named **local** Docker volume; never an ephemeral database or shared/network filesystem. |
| `MP_MAX_MESSAGES` | `0`, disabling Mailpit's default count-based pruning. |
| `MP_MAX_AGE` | Unset, disabling age-based pruning. |
| `MP_MAX_MESSAGE_SIZE` | `1` MB per message, comfortably above the queue's validated payload sizes. |
| `MP_IGNORE_DUPLICATE_IDS` | `false`, retaining at-least-once delivery evidence. |
| `MP_SMTP_BIND_ADDR` | `0.0.0.0:1025` inside the container; reachable only from the trusted Compose network. |
| `MP_SMTP_MAX_RECIPIENTS` | `1`, matching the queue's one-recipient-per-job contract. |
| `MP_UI_BIND_ADDR` | `0.0.0.0:8025` inside the container; publish as `127.0.0.1:8025:8025` on the host. |
| `MP_ALLOWED_HOSTS` | `mailpit` for internal UI/API calls; Mailpit also permits loopback host names and addresses. |
| `MP_DISABLE_VERSION_CHECK` | `true`, avoiding an external update check from the running service. |
| `MP_BLOCK_REMOTE_CSS_AND_FONTS` | `true`, limiting remote resources when captured HTML is viewed. |
| `MP_ENABLE_CHAOS` | `false`; do not set `MP_CHAOS_TRIGGERS`. |

Leave SMTP and UI authentication and TLS unset only for this **host-local trusted demo**. Keep `MP_API_CORS`, SMTP relay/forward settings, Send API authentication overrides, and POP3 credentials unset; do not grant cross-origin browser access to Mailpit's API. Do not enable Mailpit options that fetch internal URLs or bypass TLS validation. The queue config uses `SMTP_HOST=mailpit` and `SMTP_PORT=1025`; the frontend runtime config uses `MAILPIT_ORIGIN=http://127.0.0.1:8025`. The latter is a browser URL, not an internal DNS name. [Mailpit documents the SMTP defaults](https://mailpit.axllent.org/docs/usage/sending-messages/), [HTTP host allowlist](https://mailpit.axllent.org/docs/configuration/http/), and [storage/pruning controls](https://mailpit.axllent.org/docs/configuration/email-storage/).

Mailpit's local SQLite database uses WAL by default. Keep the volume on a local Docker filesystem and include the database and WAL files in a consistent backup. For upgrades, stop the queue's worker/traffic and Mailpit, take a cold volume backup, then start the replacement image and verify the inbox. Do not copy only `mailpit.db` while Mailpit is writing. No service-owned schema or Knex migrations are added; Mailpit owns any database schema changes. Never run a `down` migration or delete the volume as an upgrade or rollback step.

The UI and API share port `8025`. The API is used by internal test assertions only; the frontend simply opens the UI. Because local users can inspect, send, and delete through Mailpit's native UI/API, this deployment must remain host-local and trusted. Keep captured bodies out of application logs and never configure real SMTP relay or forwarding. Mailpit's successful SMTP acceptance means **captured in the demo inbox**, not delivered to a real recipient.

## 4. Health, observability, and recovery

Use Mailpit's native `/livez` and `/readyz` endpoints in the Compose health check; both return HTTP `200` when healthy. The health check must run inside the container and must not depend on the host-published port. Also verify SMTP connectivity from the queue network during deployment, since HTTP readiness alone does not prove the queue's SMTP path. [Mailpit healthcheck documentation](https://mailpit.axllent.org/docs/integration/healthcheck/).

Send Mailpit process output to container stdout/stderr and retain Compose logs for diagnosis. Do not enable verbose message-body logging. Inspect mailbox count and volume free space during the demo because automatic pruning is disabled. If Mailpit stops or its volume becomes unwritable/full, SMTP acceptance fails and the queue's own retry/dead-job behavior applies; do not infer that an accepted queue job reached the inbox. On restart with the same volume, previously captured messages must remain visible. A deliberate disposable-demo reset removes only the Mailpit volume after explicitly identifying it and recording that captured-message history will be lost; it does not reset queue or API data.

## 5. Test gates

All gates are mandatory before deployment. Tests use disposable volumes and mailboxes; never clear a developer's persistent inbox as part of automated tests. There is no custom Mailpit application code requiring a synthetic unit-test suite; validate the image/configuration and exercise real SMTP, HTTP, and Compose behavior. A skipped required gate is incomplete, not passing.

| Gate | Pass condition |
| --- | --- |
| Source/build | The pinned Mailpit source and Alpine patch release are verifiable; UI and Go builds reproduce; license notices are present; the final image starts as non-root and has no build toolchain. |
| Configuration/exposure | The generated Compose configuration has one Mailpit container, a writable named local volume, internal SMTP only, loopback-only `8025`, expected host allowlist, no browser CORS, no relay/forward/POP3/Chaos, and no secrets baked into the image. |
| Health | `/livez` and `/readyz` return `200` from inside the container; readiness fails or startup is blocked when the database cannot be opened/written. Queue-network SMTP connectivity is verified separately. |
| SMTP capture | An email sent by the real queue to `mailpit:1025` appears in the Mailpit API/UI with the expected sender, one recipient, subject, text, and optional HTML. SMTP acceptance is not called real-world delivery. |
| Duplicate evidence | Two successful queue deliveries of the same notification produce two visible Mailpit messages, including when the email Message-ID repeats. |
| Retention/restart | Messages remain after a Mailpit container restart with the same volume; config inspection proves count and age pruning are disabled. An explicit test-volume reset starts with an empty inbox without touching queue/API volumes. |
| Capacity/error | An unwritable or full Mailpit volume causes visible startup/readiness or SMTP failure, and logs identify the storage problem without exposing email bodies. No accepted message is claimed unless it appears in the mailbox. |
| Browser access | A real browser can follow the frontend's Mailpit link to `http://127.0.0.1:8025`; UI and native API work from the Compose host, SMTP is not published, and the UI cannot be reached through a non-loopback host interface. |
| Compose end-to-end | With the API, queue, and real Mailpit containers, expected user/admin payment notifications appear for success and failure cases. Interrupt Mailpit, observe queue retry or retained failure state, restore Mailpit, and confirm any eligible retried message is captured without altering payment state. |

The queue's SMTP 4xx/5xx classification is tested against a separate test SMTP server, not Mailpit Chaos. Its test contract must reflect that distinction; Mailpit's gate covers normal capture and service outage/recovery. Record every gate, command, result, and any unrun suite.

## 6. Deployment gates and rollback

| Gate | Requirement before proceeding |
| --- | --- |
| D1: artifact | Build from pinned Mailpit `v1.33.1` source with the verified revision/checksum and exact `alpine:3.24.4` bases; record image digest, verify non-root runtime and licensing, and pass source/build tests. |
| D2: configuration and storage | Verify one container, local volume ownership/write access/free space, `MP_DATABASE`, disabled pruning/relay/forwarding/Chaos, internal SMTP, loopback UI binding, and matching queue/frontend addresses. Back up an existing inbox consistently before upgrade. |
| D3: readiness | Start Mailpit; require healthy `/livez` and `/readyz`, host-local UI/API access, and queue-network SMTP connectivity. Do not treat the service as ready if database writes or SMTP are unavailable. |
| D4: functional smoke | Submit a real queue email, inspect sender/recipient/subject/text/HTML in the inbox, verify the frontend link, restart Mailpit, and confirm the message persists. |
| D5: recovery smoke | Interrupt Mailpit during a disposable test flow, verify the queue's observable failure/retry state, restore Mailpit, and confirm an eligible retried email appears. Verify duplicate messages remain distinct and payment state is unchanged by the outage. |
| D6: operations | README covers start/stop, host-local inbox URL, Compose SMTP address, health checks, logs, volume/backup/restore, capacity monitoring, test commands, and explicit disposable-volume reset. Record every gate result and any unrun check. |

If rollout fails, keep the Mailpit volume and logs. Restore the previous image only if it can read the existing Mailpit database; otherwise restore the verified pre-upgrade backup into an isolated volume before restarting the previous image. Preserve queue and API volumes throughout. Do not expose the UI beyond loopback or claim deployment acceptance from a passing build alone.
