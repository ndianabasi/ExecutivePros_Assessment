# Message Queue Service Implementation Checklist

Source of truth: [Message_Queue_Service_Implementation.md](Message_Queue_Service_Implementation.md). Check each task only after its implementation or stated gate has been verified. Leave failed, skipped, or blocked gates unchecked and record their results. This list covers the Message Queue Service and its API integration contract; it does not assign implementation of the API Service or Mock Email Service to the queue.

## 1. Workspace and service structure

- [ ] Create a TypeScript/Node.js Yarn workspace with an Express HTTP entry point.
- [ ] Add workspace scripts for `lint`, `typecheck`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, and `build`.
- [ ] Keep configuration, authentication, request validation, Workmatic adapter, SMTP sender, logging, and health handling in separate modules.
- [ ] Configure one Workmatic `emails` queue and register its processor before the server accepts jobs.
- [ ] Run the HTTP server and a worker with concurrency two in one queue container.
- [ ] Keep `POST /jobs` as the only business route; expose no job status, cancel, retry, management, or Workmatic dashboard route.
- [ ] Accept only email jobs; reject every other job type.
- [ ] Keep payment decisions, recipient selection, and email rendering in the API Service; do not query `api.db` or render payment templates in the queue.
- [ ] Send all accepted email jobs through Mailpit SMTP, not another mail destination.

## 2. `jobs.db`, migrations, and durable admission

- [ ] Store Workmatic jobs in persistent SQLite at `JOBS_DB_PATH`, never in an in-memory database outside tests.
- [ ] Add a prestart command that opens or creates `jobs.db` through Workmatic `createDatabase()` and verifies its schema before serving HTTP.
- [ ] Keep Workmatic's internal tables library-owned; do not query or mutate them through Knex or another service.
- [ ] Keep a `database/migrations` directory and Knex CLI scripts for any future queue-owned tables; do not invent service-owned tables for this version.
- [ ] Connect Workmatic initialization and any queue-owned `up` migrations to the root Commander prestart migration flow.
- [ ] Disallow production `down` migrations.
- [ ] Call Workmatic `client.add()` directly for each valid `POST /jobs`; do not add a queue-side admission or deduplication ledger.
- [ ] Return acceptance only after Workmatic confirms the job is persisted; return `503` if durable enqueue fails or the result is uncertain.
- [ ] Preserve the full validated email payload plus request/correlation metadata in the persistent job.
- [ ] Treat `notification_key` as correlation metadata only: repeated submissions may create separate job IDs and emails.
- [ ] Retain completed and dead Workmatic rows until an explicitly authorized reset of a disposable demo volume; schedule no automatic purge.

## 3. Configuration, network, and lifecycle

- [ ] Validate `NODE_ENV`, `PORT`, `JOBS_DB_PATH`, `QUEUE_SERVICE_SECRET`, `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` before listening.
- [ ] Reject missing or weak service secrets, invalid database paths or ports, and invalid sender configuration at startup.
- [ ] Load secrets from runtime environment or mounted secret files; keep them out of source, images, seeds, responses, and logs.
- [ ] Fix `SMTP_HOST` to the internal Compose Mailpit hostname; never accept an SMTP host or delivery URL from a job.
- [ ] Keep the queue HTTP listener private to the trusted Compose network, with no public queue port and no browser CORS.
- [ ] Set demo defaults: worker concurrency two, three total attempts, 5-second initial retry delay, 10-second SMTP timeout, 20-second job timeout, 30-second lease, and 1-second idle poll.
- [ ] Validate `SMTP_TIMEOUT_MS < EMAIL_JOB_TIMEOUT_MS < EMAIL_LEASE_MS` for overrides.
- [ ] Make retry timing and timeouts short-configurable or injectable for deterministic tests.
- [ ] Use configured `SMTP_FROM`, one recipient per job, and plain SMTP only on the isolated Mailpit network.
- [ ] Start in order: validate config, initialize database, register processor, start worker, then accept HTTP traffic.
- [ ] Start the worker on every restart without persisting a paused state that could silently stop processing.
- [ ] On SIGTERM/SIGINT, stop accepting requests, drain in-flight work within a bounded grace period, and close SMTP/database connections.
- [ ] Verify jobs and expired leases recover after a process or container restart.

## 4. HTTP contract, authentication, and validation

- [ ] Implement internal `POST /jobs` with `Authorization: Bearer <QUEUE_SERVICE_SECRET>` and safe secret comparison.
- [ ] Accept JSON only, enforce a 64 KiB body limit, reject unknown fields, and validate before enqueue.
- [ ] Require `type: "email"`, `notification_key`, one `to` address, `subject`, and nonempty `text`; allow optional `html` and `payment_reference`.
- [ ] Validate `notification_key` as 1–200 printable characters and explicitly avoid treating it as an idempotency key.
- [ ] Validate one syntactically valid recipient address, 1–200-character subject without line breaks, 1–20,000-character text, and optional HTML of at most 40,000 characters.
- [ ] Reject control characters and caller-supplied SMTP host, sender, CC/BCC, attachments, arbitrary headers, or delivery URLs.
- [ ] Do not fetch resources from HTML or interpret HTML as instructions.
- [ ] Validate an upstream request ID or generate one; carry it into the persisted job for logs.
- [ ] Return `202` with Workmatic `job_id`, `status: "queued"`, and `request_id` only after durable enqueue; do not imply SMTP delivery.
- [ ] Return `401` for service-auth failure, `400` for malformed JSON/unknown type, `413` for oversize input, and `422` for invalid email fields.
- [ ] Return `503` for failed/uncertain enqueue and sanitized `500` for unexpected errors, each with request ID and no secrets or message body.
- [ ] Permit a second valid request with the same notification key to create a new job ID.
- [ ] Implement internal `GET /health/live` for process liveness.
- [ ] Implement internal `GET /health/ready` for valid config, writable initialized `jobs.db`, and an initialized/running worker.
- [ ] Keep readiness true during SMTP outages when durable job admission still works; log SMTP degradation separately.
- [ ] Restrict health routes to the trusted network or host loopback.

## 5. Workmatic worker and Mailpit delivery

- [ ] Enqueue each email with Workmatic `maxAttempts: 3`.
- [ ] Use a fixed Mailpit SMTP transport, such as Nodemailer, with the configured sender and validated recipient/content.
- [ ] Treat successful Mailpit SMTP acceptance as completion of this simulation; do not track inbox views or external delivery.
- [ ] Classify connection failures, SMTP timeouts, and SMTP 4xx responses as transient; throw so Workmatic retries.
- [ ] Configure backoff for 5 seconds after the first transient failure and 10 seconds after the second; make the third failed attempt `dead`.
- [ ] Classify SMTP 5xx responses as permanent, log `permanent_rejection` at error level, and resolve the handler after one attempt.
- [ ] Document and test that Workmatic marks permanent rejections `done` even though SMTP did not accept the email.
- [ ] Reject obviously invalid email input at HTTP admission so no job is created for it.
- [ ] Preserve at-least-once behavior: a crash/lease expiry or ambiguous SMTP `DATA` timeout after acceptance may send the email again.
- [ ] Do not silently deduplicate by `notification_key`, claim exactly-once delivery, or change payment state when email delivery fails.
- [ ] Leave exhausted transient jobs in Workmatic's `dead` state without a dashboard, dead-job alert, inspection endpoint, or supported manual replay workflow.

## 6. Logs, privacy, and operational documentation

- [ ] Use Pino for request completion, enqueue success/failure, every SMTP attempt, successful acceptance, permanent rejection, and final transient exhaustion.
- [ ] Include request ID, Workmatic job ID, **hash** of notification key, payment reference, attempt number, duration, and error class in relevant logs.
- [ ] Redact the service token, any SMTP credentials, message bodies, and recipient address from logs and errors.
- [ ] State that Workmatic `done`/`dead` counts alone are not delivered-email counts because permanent rejections resolve as `done`.
- [ ] Document the direct-enqueue duplicate risk and worker replay risk separately.
- [ ] Document the trusted-demo boundary, private network, Mailpit-only destination, and absence of dashboard/manual retry support.
- [ ] Document local start/stop, configuration, prestart initialization, test commands, Mailpit verification, retry/dead semantics, logs, backup/restore, and explicit disposable-volume reset in README.

## 7. Automated test gates — check only after passing

- [ ] **Static/build:** lint, strict typecheck, production build, lockfile consistency, secret check, and container build pass.
- [ ] **Config/startup:** missing/weak secret, invalid SMTP config, bad DB path, and invalid timeout/lease ordering fail before listening; valid config initializes Workmatic and starts the worker.
- [ ] **HTTP auth:** missing/wrong Bearer secret is rejected; a valid service request is accepted only on the internal route.
- [ ] **HTTP validation:** unknown job type, malformed JSON, bad recipient/header characters, missing text, unknown fields, and excessive sizes return the specified errors without creating jobs.
- [ ] **Durable response:** a valid request returns `202` only after `client.add()` persists the job; database failure/uncertain result returns `503`.
- [ ] **Health:** liveness and readiness reflect process/database/worker state, remain internal, and do not fail solely because SMTP is down.
- [ ] **Persistence/restart:** an accepted job survives restart in a temporary file-backed SQLite database and resumes processing.
- [ ] **Lost acknowledgement:** caller retry after an uncertain enqueue may create two jobs; tests assert the documented weaker guarantee.
- [ ] **SMTP success:** real Mailpit receives the configured sender, recipient, subject, text, and optional HTML; Workmatic marks completion after acceptance.
- [ ] **Transient retry:** connection error, timeout, and SMTP 4xx trigger exactly three total attempts with 5/10-second delays and `dead` state after exhaustion.
- [ ] **Transient recovery:** restoration before the final attempt sends successfully and ends retries.
- [ ] **Permanent rejection:** SMTP 5xx logs an error-level `permanent_rejection`, makes one attempt, and ends with Workmatic `done` without claiming delivery.
- [ ] **Duplicate submission:** two requests with one notification key can return different job IDs and send two emails.
- [ ] **Worker replay:** crash or expired lease after possible SMTP acceptance can resend; no accepted job disappears or payment state changes.
- [ ] **Shutdown:** new requests stop, in-flight work drains or recovers after restart, and durable jobs remain intact.
- [ ] **Contract:** API-rendered email body and service-auth header match `POST /jobs`; API tests/docs reflect possible duplicate emails.
- [ ] **Compose end-to-end:** real API, queue, and Mailpit containers show a durably accepted payment email in Mailpit with matching job state and correlated logs.
- [ ] **Compose outage/recovery:** SMTP outage retains/retries jobs; restoring Mailpit drains them, with job state, mailbox, and logs asserted.
- [ ] Record each test command/result and every skipped or blocked suite; do not call unit-only validation deployment acceptance.

## 8. Deployment gates — complete in order

- [ ] **D1 Configuration:** keep the queue listener private to the trusted Compose network; set non-default service secret, SMTP host/port/from, mounted `jobs.db` path, and valid timeout/lease values.
- [ ] **D1 Secrets:** confirm no secret is committed, baked into the image, or emitted in responses/logs.
- [ ] **D2 Base image:** use an exact patch-pinned Alpine Node image, record/review its digest, and avoid a moving `latest` tag or non-Alpine prebuilt service image.
- [ ] **D2 Native module:** build SQLite native dependencies such as `better-sqlite3` against the same Alpine/musl family used at runtime and verify module load.
- [ ] **D2 Runtime image:** use a multi-stage build, production-only runtime dependencies, a non-root user, a health check, and write access only to the `jobs.db` volume.
- [ ] **D2 Artifact:** reproduce Yarn install/build, smoke-start the image, and pass static, unit, integration, and contract gates before Compose smoke tests.
- [ ] **D3 Persistence:** verify volume ownership, free space, and SQLite-safe backup when an existing `jobs.db` is present.
- [ ] **D3 Initialization:** run Workmatic initialization and any queue-owned `up` migrations before service startup; prohibit deployment-time `down`.
- [ ] **D4 Readiness:** start one queue container and verify internal liveness/readiness plus persistent queue access.
- [ ] **D4 SMTP degradation:** confirm an SMTP outage appears in logs while durable enqueue/readiness remain available.
- [ ] **D5 Functional smoke:** authenticated `POST /jobs` returns `202` with a job ID, Mailpit receives the message, and logs correlate request/job/SMTP acceptance.
- [ ] **D6 Recovery smoke:** interrupt SMTP, enqueue and restart the queue, restore SMTP, and verify retry/drain.
- [ ] **D6 Failure smoke:** exercise permanent rejection and duplicate submission; confirm documented Workmatic states and duplicate-email possibility.
- [ ] **D7 Operations:** complete README instructions for setup, tests, Mailpit, retries/dead jobs, duplicate risk, logs, backup/restore, and disposable reset.
- [ ] **D7 Evidence:** record every deployment gate result and any unrun check; keep the queue unexposed if a pre-traffic gate fails.
- [ ] Prepare rollback by preserving `jobs.db` and logs, checking previous-image schema compatibility, and restoring a verified pre-upgrade backup to an isolated volume when needed.
- [ ] Never use production `down` or persistent-volume deletion as rollback; reset only an explicitly disposable demo volume.
- [ ] Check disk capacity because completed and dead jobs are retained until manual reset.

## 9. API integration contract correction

- [ ] Update [API_Service_Implementation.md](API_Service_Implementation.md) to remove its queue-side deduplication guarantee and describe `notification_key` as correlation metadata.
- [ ] Update [API_Service_Implementation_Todo.md](API_Service_Implementation_Todo.md) so its outbox, contract, and test tasks accept a duplicate job/email after a lost acknowledgement.
- [ ] Keep the API outbox requirement for durable notification intent and keep email failure independent of payment fulfilment.
- [ ] Block API-to-queue integration acceptance until both API documents and their contract tests match this queue behavior.
