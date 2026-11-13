# Message Queue Service Implementation Document

## 1. Purpose and boundary

This document specifies only the **Message Queue Service** in [System_Architecture.md](System_Architecture.md). The service accepts email jobs from the API Service, persists them in `jobs.db` using Workmatic, and sends them to the Mock Email Service through Mailpit SMTP. The API Service owns payment state, notification decisions, recipients, and rendered email content. The Mock Email Service owns its SMTP server and inbox UI. Neither service's internal implementation belongs here.

The target is a trusted assessment demo with one queue container. `POST /jobs` is its sole business endpoint. Internal liveness and readiness routes are allowed for Compose health checks; there is no job-management API or Workmatic dashboard.

### Settled behavior and limits

| Area | Decision |
| --- | --- |
| Job scope | Only email jobs are accepted. Other job types are rejected. |
| Content ownership | The API Service sends the recipient, subject, text body, and optional HTML. The queue validates and transports them; it does not query `api.db` or render payment templates. |
| Admission | `POST /jobs` calls Workmatic `client.add()` directly and acknowledges only after durable enqueue. A repeated notification key can create another job. |
| Delivery | SMTP delivery is **at least once**. A crash or timeout after Mailpit accepted a message can result in another email. |
| Retries | Transient failures get at most three total attempts, with 5-second then 10-second delays. Permanent SMTP rejection is logged at error level and ends processing without another attempt. |
| Permanent rejection accounting | The handler resolves after logging a permanent rejection, so Workmatic records the job as `done`. `done` therefore means processing finished, not necessarily that SMTP accepted the message. |
| Exhausted jobs | Workmatic retains transient failures in `dead`. There is no dashboard, alert, inspection endpoint, or supported manual replay workflow. Normal structured logs record failures. |
| Retention | Completed and dead Workmatic rows remain in `jobs.db` until an explicit reset of a disposable demo volume. No automatic deletion is scheduled. |

The [API Service implementation document](API_Service_Implementation.md) and its checklist carry the direct-enqueue contract: the API outbox may retry a lost acknowledgement, and the queue may create another job and email. Verify that behavior in API-to-queue contract tests. This document records the dependency; it does not implement the API Service.

## 2. Workspace, code layout, and database ownership

Create a TypeScript/Node.js Yarn workspace with an Express HTTP server and one Workmatic `emails` queue. Keep configuration, request authentication/validation, Workmatic adapter, SMTP sender, logging, and health handling separate. Register the worker before accepting jobs; start it on every service startup. Use one queue container with worker concurrency of two.

Use a persistent SQLite file at `JOBS_DB_PATH`. Workmatic's `createDatabase()` initializes and owns its internal tables. Do not write Workmatic's tables through Knex or read another service's database. Keep the service's `database/migrations` directory and Knex CLI scripts for any **service-owned** tables added later; there are none in this version. A prestart initialization command must open/create `jobs.db` and validate Workmatic's schema before the HTTP server starts. The root Commander migration flow should invoke that command alongside other services' migration steps. Production `down` migrations are prohibited. This boundary reconciles the architecture's Knex rule with Workmatic's own SQLite/Kysely implementation. [Workmatic documents its database initialization and enqueue API.](https://github.com/litepacks/workmatic)

Implementation sequence:

1. Workspace scripts, config validation, logger, authentication, request validation, health, and Workmatic database initialization.
2. `POST /jobs` with durable enqueue and explicit response/error contract.
3. Mailpit SMTP transport and Workmatic worker with failure classification and retry policy.
4. Unit, integration, contract, and Compose tests; container and deployment gates; README instructions.

## 3. Configuration and lifecycle

Required runtime configuration: `NODE_ENV`, `PORT`, `JOBS_DB_PATH`, `QUEUE_SERVICE_SECRET`, `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM`. The queue authenticates the API Service with the shared secret. Use runtime environment or mounted secret files; reject missing/weak secrets and invalid paths/ports before startup. The SMTP host is a fixed internal Compose hostname, never supplied by a job. Keep the HTTP listener on the trusted Compose network; publish no public queue port.

Default worker settings for the demo: `EMAIL_WORKER_CONCURRENCY=2`, `EMAIL_MAX_ATTEMPTS=3`, `EMAIL_RETRY_INITIAL_MS=5000`, `SMTP_TIMEOUT_MS=10000`, `EMAIL_JOB_TIMEOUT_MS=20000`, `EMAIL_LEASE_MS=30000`, and a 1-second idle poll. The first transient failure schedules a retry after 5 seconds, the second after 10 seconds, and the third makes the Workmatic job `dead`. The job timeout is longer than the SMTP timeout and shorter than the lease. Validate this ordering when config overrides are supplied. Make timeouts/backoff injectable or short-configurable for deterministic tests.

Use a configured `SMTP_FROM` address, one recipient per job, and plain SMTP on the isolated Mailpit Compose network. Do not accept caller-supplied SMTP host, sender, CC/BCC, attachments, arbitrary headers, or delivery URLs. Mailpit's successful SMTP acceptance is the success boundary for this simulation; the queue does not track inbox views or real-world delivery.

On startup, validate config, open/initialize `jobs.db`, register the `emails` processor, start the worker, then listen for HTTP requests. On SIGTERM/SIGINT, stop accepting requests and call Workmatic's graceful worker stop with a bounded container shutdown window; close SMTP and database connections. Workmatic's persisted jobs and leases provide restart recovery. Do not persist a paused worker state that would silently prevent processing after restart.

## 4. HTTP contract

`POST /jobs` is an internal service-to-service route. Require `Authorization: Bearer <QUEUE_SERVICE_SECRET>` and compare the supplied secret safely. Do not enable browser CORS. Accept JSON only, enforce a 64 KiB request-body limit, reject unknown fields, and validate before enqueue. Generate a request ID if a valid upstream ID is absent; carry it into the job payload for later logs.

The request body is:

```json
{
  "type": "email",
  "notification_key": "notif_4f81c2a9",
  "to": "user@example.test",
  "subject": "Payment successful",
  "text": "Your payment was successful.",
  "html": "<p>Your payment was successful.</p>",
  "payment_reference": "payment-ref"
}
```

`type`, `notification_key`, `to`, `subject`, and `text` are required. `html` and `payment_reference` are optional. `notification_key` is an opaque correlation value of 1–200 printable characters, **not** an idempotency key. `to` is one syntactically valid email address; `subject` is 1–200 characters without line breaks; `text` is 1–20,000 characters; `html`, when present, is at most 40,000 characters. Reject control characters that could inject headers. Do not interpret HTML as instructions or fetch resources referenced inside it. The API owns correct recipient selection and content; the queue enforces shape and transport safety.

Return `202 Accepted` with `{ "job_id": "<Workmatic ID>", "status": "queued", "request_id": "<ID>" }` only after Workmatic confirms persistence. The response means **durably queued**, not delivered. A second valid request with the same `notification_key` returns a new job ID and can produce another email. If `client.add()` fails or its result is uncertain, return `503`; the caller may retry but must accept the duplicate risk. Use `401` for missing/invalid service authentication, `400` for malformed JSON/unknown type, `413` for oversize input, and `422` for invalid email fields. Unexpected errors return a sanitized `500` with request ID. Do not expose message bodies or secrets in error responses.

`GET /health/live` checks that the process is running. `GET /health/ready` checks valid configuration, a writable initialized `jobs.db`, and an initialized/running worker. These routes are accessible only on the trusted network or host loopback. SMTP failure does not make the queue unready because durable admission can continue while delivery retries. Log SMTP degradation separately. No job status, cancel, retry, or dashboard route is exposed.

## 5. Worker, SMTP, and failure handling

Call Workmatic `client.add(payload, { maxAttempts: 3 })` for each accepted request. Keep the full validated email payload and correlation metadata in the persistent job. The worker uses an SMTP client such as Nodemailer with a fixed Mailpit transport. Treat a successful SMTP acceptance response as completion. Workmatic marks the job `done` after the handler resolves.

Classify connection failures, timeouts, and SMTP 4xx responses as transient: log request ID, job ID, payment reference, attempt, and redacted reason, then throw so Workmatic applies the 5/10-second backoff and eventually marks the job `dead`. Classify SMTP 5xx responses as permanent: log an error-level `permanent_rejection` outcome and return successfully so no replay occurs. Input that is clearly invalid is rejected by `POST /jobs` and never queued. Workmatic's documented handler behavior retries thrown errors and marks resolved handlers done; it does not provide a documented per-error immediate-dead result. [See its worker implementation.](https://github.com/litepacks/workmatic/blob/main/src/worker.ts)

At-least-once delivery remains true even for a single job: if Mailpit accepts a message and the worker crashes before Workmatic marks it done, the lease can expire and the job can send again. A timeout after SMTP `DATA` can likewise be ambiguous. Do not claim exactly-once email delivery, deduplicate silently by `notification_key`, or reverse API payment state because of email failure. Duplicate `POST /jobs` calls can create duplicate jobs independently of worker replay.

Use Pino structured logs for request completion, enqueue success/failure, each SMTP attempt, successful acceptance, permanent rejection, and final transient exhaustion. Include request ID, Workmatic job ID, a hash of the notification key, payment reference, attempt number, timing, and error class. Redact the service token, SMTP credentials if later added, message bodies, and recipient address. Workmatic `done`/`dead` counts alone are **not** delivered-email counts because permanent rejections resolve as done. There is no dashboard, dedicated dead-job alert, or replay command in this version; normal logs and the retained database are the evidence available during the demo.

## 6. Test gates

All gates are mandatory before deployment. Use **Japa v5** (`@japa/runner` 5.x, not the legacy `japa` package) for unit, integration, contract, and Compose end-to-end tests. Pin an exact 5.x runner release and compatible `@japa/assert` and `@japa/api-client` releases in the Yarn lockfile after checking peer dependencies. Configure a service-owned ESM `bin/test.ts` with Japa `processCLIArgs`, `configure`, and `run`; use an ESM-compatible TypeScript executor supported by the pinned Node version. Define named `unit`, `integration`, `contract`, and `e2e` suites. `test` runs all suites; `test:unit`, `test:integration`, `test:contract`, and `test:e2e` select their named suites through that entry point. Keep `lint`, `typecheck`, and `build` separate. [Japa setup and suite selection](https://japa.dev/docs/installation).

Use Japa assertions and lifecycle hooks to create and remove isolated temporary **file-backed** SQLite databases and to start the queue HTTP listener on an ephemeral port for Japa API-client tests. Put Workmatic persistence/restart and SMTP classification tests in `integration`, API payload/auth fixtures in `contract`, and real API/queue/Mailpit Compose and process-crash recovery in `e2e`. Use injectable clocks/short retry intervals where timing is deterministic; exercise an actual child-process restart for the durability gate. Do not use a developer's `jobs.db` or share a SQLite file across independently running tests. A skipped required suite is incomplete, not passing.

| Gate | Pass condition |
| --- | --- |
| Static/build | Lint, strict TypeScript check, production build, lockfile consistency, no committed secrets, and container build pass. |
| Config/startup | Missing/weak secret, invalid SMTP config, bad database path, and invalid timeout/lease ordering fail before listening; valid config initializes Workmatic and starts the worker. |
| HTTP/auth/validation | Unauthorized calls fail; valid email job returns `202` only after durable enqueue; unknown type, invalid recipient/header characters, missing text, excessive sizes, and malformed JSON produce specified errors and no job. Health routes remain internal. |
| Persistence/restart | Enqueued job survives process restart; an enqueue database failure returns `503`; a lost HTTP acknowledgement followed by a caller retry may create two jobs and is documented as such. |
| SMTP success | A valid job reaches real Mailpit SMTP, produces the expected sender/recipient/subject/text/HTML, and Workmatic records completion after SMTP acceptance. |
| Transient retry | Connection failure, timeout, and SMTP 4xx get three total attempts with 5/10-second backoff and end in `dead` after exhaustion. Recovery before exhaustion sends successfully. |
| Permanent rejection | SMTP 5xx logs `permanent_rejection` at error level, makes one attempt, and leaves Workmatic `done`; tests do not misinterpret `done` as delivered. |
| Duplicate/replay | Two submissions with one notification key can produce two job IDs/emails. A worker crash or expired lease after possible SMTP acceptance can resend, and no payment state is changed. |
| Shutdown | New requests stop; in-flight jobs drain within the grace window or recover after restart; no accepted job disappears. |
| Contract | The API's rendered email payload matches this schema and its service-auth header; API integration tests use the weaker duplicate guarantee. |
| Compose end-to-end | With the API, queue, and real Mailpit containers, a payment notification is durably accepted and appears in Mailpit; SMTP outage leaves jobs queued/retrying, and restoration drains them. Assert job state, mailbox result, and logs. |

The test report must name each gate, command, result, and any unrun suite. Passing unit tests alone is not deployment acceptance.

## 7. Deployment gates and rollback

Build one queue image from an exact patch-pinned Alpine Node base. Use a multi-stage Dockerfile; build native SQLite dependencies such as `better-sqlite3` against the same Alpine/musl family used at runtime, and verify the resulting image starts. Keep only runtime dependencies in the final stage, run as non-root, and give write access only to the `jobs.db` volume. Do not use a moving `latest` tag or a non-Alpine prebuilt service image.

| Gate | Requirement before proceeding |
| --- | --- |
| D1: configuration | Queue listener is private to the trusted Compose network; non-default service secret, SMTP host/port/from, mounted database path, and worker timeout/lease settings are valid. No secret is in the image or repository. |
| D2: artifact | Reproducible Yarn install/build, patch-pinned Alpine image and recorded digest, native SQLite module load, image smoke start, and static/unit/integration/contract gates pass. |
| D3: persistence | Verify volume ownership, free space, and a SQLite-safe backup if `jobs.db` already exists. Run Workmatic initialization and any queue-owned `up` migrations before starting the service. Never run `down` in deployment. |
| D4: readiness | Start the single container, verify internal liveness/readiness, confirm persistent queue access, and verify the SMTP address is configured. An SMTP outage is shown in logs without disabling durable enqueue. |
| D5: functional smoke | Authenticated `POST /jobs` returns `202` with a job ID; the message appears in Mailpit; logs correlate the request, job, and SMTP acceptance. |
| D6: recovery smoke | Interrupt SMTP, enqueue and restart the queue, restore SMTP, and verify retry/drain. Exercise permanent rejection and duplicate submission; confirm their documented statuses and possible duplicate email. |
| D7: operations | README explains local start/stop, config, prestart initialization, test commands, Mailpit verification, retry/dead semantics, duplicate risk, logs, backup/restore, and explicit disposable-volume reset. Record every gate result and any unrun check. |

If a gate fails before traffic, keep the queue unexposed. For a failed image rollout, preserve `jobs.db` and logs; restore the previous image only if it can read the existing Workmatic schema. Otherwise restore a verified pre-upgrade backup into an isolated volume. Never use a production `down` migration or delete a persistent volume as rollback. Completed and dead jobs are not automatically purged, so disk-capacity checks are part of deployment. Reset is allowed only for an explicitly disposable demo volume.

## 8. Cross-service contract verification

Before integration acceptance, verify [API_Service_Implementation.md](API_Service_Implementation.md) and [API_Service_Implementation_Todo.md](API_Service_Implementation_Todo.md) against this contract: `POST /jobs` durably accepts each call, `notification_key` is correlation metadata, a lost acknowledgement can lead to another job/email, and SMTP processing itself is at least once. The API outbox prevents **lost notification intent**; duplicate email is the accepted tradeoff. The API Service must continue to treat queue failures independently of payment fulfilment.
