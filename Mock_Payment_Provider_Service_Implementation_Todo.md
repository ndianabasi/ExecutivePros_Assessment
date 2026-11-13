# Mock Payment Provider Service Implementation Checklist

Source of truth: [Mock_Payment_Provider_Service_Implementation.md](Mock_Payment_Provider_Service_Implementation.md). Check each task only after its implementation or named gate has been verified. Leave failed, skipped, and blocked gates unchecked and record their results. This list covers provider-owned work and verifies its API/frontend handoffs; it does not assign their implementations to this service.

## 1. Workspace and service boundary

- [ ] Create one strict TypeScript/Node.js Yarn workspace with Express, VineJS, Knex, Workmatic, and Pino.
- [ ] Provide `lint`, `typecheck`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, and `build` scripts.
- [ ] Keep configuration, authenticated routes, browser checkout, repositories, scenarios, webhook dispatch, worker, and logging in separate modules.
- [ ] Keep API cart/payment verification, fulfilment, reconciliation, SSE, and notifications outside the provider service.
- [ ] Run one provider process/container; add no endpoint that directly confirms an API payment or grants API-side value.
- [ ] Use the agreed `POST /payments/initialise` and `POST /payments/submit` routes instead of the architecture's ambiguous `POST /payments` wording.

## 2. Database, migrations, and seeds

- [ ] Persist provider data in `/data/payment_provider.db` on a provider-owned local Docker volume.
- [ ] Create provider `payments`, `webhook_events`, `webhook_deliveries`, and `failure_scenarios` through provider-owned Knex migrations.
- [ ] Enforce unique API payment reference, provider reference, webhook event ID, and `(webhook_event_id, attempt_number)`.
- [ ] Enforce payment, event, delivery, and scenario status/category checks, foreign keys, and required timestamps.
- [ ] Add checkout-token hash, immutable payment URL, immutable `checkout_expires_at`, selected scenario snapshot, provider reference, and `completed_at` to provider payments.
- [ ] Add event scheduling/dispatch claim/lease/job correlation fields and indexes for due-event scans and event/attempt lookup.
- [ ] Persist original canonical event payload separately from actual transmitted body/hash, bounded/redacted response text, error class, and attempt timing.
- [ ] Preserve distinct provider payment status and webhook delivery/event status; do not infer one from the other.
- [ ] Use Knex schema methods only in migrations and named-binding `knex.raw` for provider-domain runtime SQL.
- [ ] Pass Workmatic an existing configured `better-sqlite3` connection to the **same `payment_provider.db` file**; leave its internal tables library-owned and unqueried by Knex.
- [ ] Enable and verify foreign keys on every connection, WAL on the local volume, finite busy timeout, and expected provider/Workmatic schema at startup.
- [ ] Retry a whole safe transaction within a bound on `SQLITE_BUSY`; never retry only an arbitrary partial statement sequence or hold a write transaction across HTTP/timers.
- [ ] Add provider `migrate:up` and local/test-only `migrate:down`; connect provider `up` migrations and Workmatic initialization to the root Commander prestart flow.
- [ ] Disallow production `down` migrations.
- [ ] Seed the exact active architecture scenarios idempotently without overwriting runtime payments or their scenario snapshots.
- [ ] Retain completed, failed, and skipped events, delivery attempts, and Workmatic done/dead jobs until an explicit disposable-volume reset.
- [ ] Never read or write `api.db` or the Message Queue Service's `jobs.db`.

## 3. Configuration, security, and lifecycle

- [ ] Validate `NODE_ENV`, `PORT`, `PROVIDER_DB_PATH`, `PROVIDER_PUBLIC_ORIGIN`, `FRONTEND_ORIGIN`, `API_WEBHOOK_URL`, `PROVIDER_SERVICE_SECRET`, and `PROVIDER_WEBHOOK_SECRET` before listening.
- [ ] Reject weak/missing secrets, invalid origins/callback URL, and a database path outside the mounted directory.
- [ ] Load secrets from runtime environment or mounted secret files; keep them out of repository, image, seeds, browser config, URLs, errors, and logs.
- [ ] Fix the API callback to the configured internal `/v1/webhooks/payment` URL; accept no browser/user-supplied callback and follow no arbitrary redirect.
- [ ] Configure a browser-reachable provider public origin distinct from the API's internal Compose provider address.
- [ ] Bind browser access to the trusted host-loopback deployment and keep server-authenticated routes available only on the trusted network.
- [ ] Configure Workmatic worker, HTTP timeout, job timeout, lease, and backoff with validated ordering and fast deterministic test overrides.
- [ ] Start in order: provider migrations/seeds, Workmatic initialization, due-event sweep, worker registration/start, then HTTP listener.
- [ ] Start the worker on every restart without a persisted paused state.
- [ ] On SIGTERM/SIGINT, stop new requests, drain bounded in-flight work, and leave events/jobs restartable.

## 4. API-only routes and initialization

- [ ] Require `Authorization: Bearer <PROVIDER_SERVICE_SECRET>` on `POST /payments/initialise`, `GET /payments/:reference`, and `GET /failure-scenarios`; compare safely and reject user Bearer tokens.
- [ ] Use VineJS to validate JSON bodies, paths, scenario codes, and input sizes; return sanitized errors with request ID and no stack traces or sensitive values.
- [ ] Keep browser CORS disabled for server-to-server routes.
- [ ] Implement `POST /payments/initialise` with API-owned `reference`, positive safe-integer minor-unit `amount`, `currency: "NGN"`, fixed UTC `checkout_expires_at`, and optional active `failure_scenario_code`.
- [ ] Check an existing-reference replay first; return its original provider reference, URL, status, and cutoff even if the cutoff has since passed.
- [ ] On a new request, validate future bounded cutoff, active scenario, supported currency, safe reference, and amount; return `201` after durable creation.
- [ ] Fingerprint immutable reference details including amount, currency, cutoff, and scenario; return `200` for exact replay and `409` for conflicting details.
- [ ] Generate an unguessable 256-bit checkout token and unique provider reference; store the token hash and retrievable payment URL without logging the raw capability.
- [ ] Ensure concurrent initializations with one reference create one row/URL and do not hold a database write lock during simulated delay.
- [ ] Return `401` for bad service auth, `422` for invalid domain input, and `503` for transient storage failure.
- [ ] Implement read-only `GET /payments/:reference` with authoritative provider status, reference, provider reference, amount, currency, payment URL, and cutoff.
- [ ] Return `404` from status lookup until delayed initialization actually commits; never treat this read route as payment confirmation.
- [ ] Implement `GET /failure-scenarios` with only active code/name/description/category in stable code order and no edit API or secret config.
- [ ] For `PROVIDER_001`, delay 30 seconds before persistence, continue after client disconnect, and converge same-reference retries on one row.
- [ ] For `PROVIDER_002`, return HTTP `500` before persistence; do not leave a provider payment row.
- [ ] Keep lost-response-after-commit behavior in an external test proxy, not a runtime provider scenario or route.

## 5. Browser checkout and payment transition

- [ ] Implement token-protected `GET /checkout/:token` using token-hash lookup; show trusted amount, currency, reference, and selected scenario.
- [ ] Render labelled Pay, Fail, and Cancel actions with keyboard/focus/readable status behavior; collect no card number or real payment data.
- [ ] Restrict `WEBHOOK_008` checkout to Pay and explain its conflicting-event demonstration on the page.
- [ ] Make the page work in the frontend iframe and as a standalone new tab without relying on top-level navigation or automatic popups.
- [ ] Implement browser `POST /payments/submit` with only bounded `checkout_token` and `outcome` (`success`, `failed`, `cancelled`) fields; require no API user token.
- [ ] Return `404` for an invalid token, `410` for new completion after cutoff, and `409` for an outcome conflicting with an existing terminal payment.
- [ ] Show an existing terminal outcome on page reload or exact repeat submission without creating another event.
- [ ] Leave a still-pending provider payment `pending` after checkout expiry so the API's day-30 lookup can observe it.
- [ ] Conditionally commit one terminal provider transition, `completed_at`, immutable event(s), and durable dispatch intent in one DB transaction before returning a completion page.
- [ ] Keep provider completion independent of API webhook acknowledgment and do not reverse provider truth because delivery fails.
- [ ] Send `postMessage({ type: 'mock-payment.finished', reference })` only to exact `FRONTEND_ORIGIN` after a committed outcome in a framed page; include no status or token.
- [ ] Show standalone-tab guidance to return to the frontend and refresh, since it has no active iframe parent message.
- [ ] Send no-store and no-referrer headers for token-bearing pages, a restrictive self-only resource CSP, and `frame-ancestors` permitting the configured frontend origin.
- [ ] Omit a conflicting `X-Frame-Options` restriction and any third-party checkout assets; never log raw token-bearing paths.

## 6. Webhook event outbox, worker, and signing

- [ ] Create immutable events with unique stable `event_id`, `payment.success`/`payment.failed`/`payment.cancelled` type, provider reference, amount, currency, status, and occurrence time.
- [ ] Serialize each canonical event body once and preserve it separately from any scenario-mutated transmitted bytes.
- [ ] Sign exact transmitted bytes using HMAC-SHA-256 and `PROVIDER_WEBHOOK_SECRET` in `X-Provider-Signature: sha256=<hex>`.
- [ ] Reuse event ID and transmitted body on normal retries; never include the secret in body, browser state, or logs.
- [ ] Deliver only to fixed internal `API_WEBHOOK_URL`, with request ID, bounded request/response sizes, bounded timeout, and no arbitrary redirects.
- [ ] Treat `webhook_events` as a durable outbox and scan/claim due events in bounded batches after outcome commit and on restart.
- [ ] Enqueue claimed events to Workmatic `webhooks` in the same provider DB, then persist job correlation; recover expired claims.
- [ ] Accept that a crash after enqueue but before correlation can create a duplicate job, and keep event-ID idempotency intact.
- [ ] Set five Workmatic delivery rounds with 2/4/8/16-second retry delays; configure HTTP timeout < job timeout < lease.
- [ ] Treat network errors, timeouts, HTTP `5xx`, `408`, and `429` as retryable when no submission in the round got `2xx`.
- [ ] Treat API `2xx` as acknowledgment; finish deliberate duplicate copies in that round and mark delivered only after planned copies finish with at least one `2xx`.
- [ ] Treat permanent API `4xx` as non-retryable when no copy was acknowledged; mark event `failed` and resolve the Workmatic handler.
- [ ] Leave exhausted transient events `failed` and Workmatic jobs `dead`; explain that Workmatic `done` after permanent rejection does not mean delivery.
- [ ] Allocate distinct atomic attempt numbers and record each HTTP submission, including concurrent duplicates, with status/code/timing/redacted response or error.
- [ ] Keep skipped events `skipped` with no delivery job; allow API reconciliation to recover the provider outcome.
- [ ] Expose no Workmatic dashboard, manual replay route, or automatic replay after terminal failure.

## 7. Seeded scenario behavior

- [ ] `PROVIDER_001`: 30-second pre-persistence initialization delay.
- [ ] `PROVIDER_002`: HTTP `500` before provider payment creation.
- [ ] `WEBHOOK_001`: two concurrent HTTP copies of the same event ID and bytes.
- [ ] `WEBHOOK_002`: three sequential copies of the same event ID and bytes, one second apart.
- [ ] `WEBHOOK_003`: schedule webhook 15 seconds after provider completion.
- [ ] `WEBHOOK_004`: keep provider outcome and mark event `skipped`, with no webhook submission.
- [ ] `WEBHOOK_008`: Pay-only provider success; send valid success event first and a separate valid failed event with a new ID only after success acknowledgment.
- [ ] `WEBHOOK_011`: keep canonical amount and provider truth; transmit amount plus 1,000 with a signature over altered bytes.
- [ ] `WEBHOOK_013`: send a valid body with an intentionally invalid signature.
- [ ] `WEBHOOK_016`: send malformed JSON with a valid signature over those malformed bytes.
- [ ] Snapshot selected scenario configuration at initialization so later seed changes do not alter an existing payment.
- [ ] Preserve canonical event/provider truth separately from actual transmitted body/signature for integrity scenarios.
- [ ] Keep client double checkout, client timeout, SSE disconnect, and API crash out of the provider scenario catalogue.

## 8. Logging, diagnostics, and operational behavior

- [ ] Use Pino plus AsyncLocalStorage; generate or validate a request ID at ingress and propagate it to webhook requests.
- [ ] Log request completion with method, route template, auth state/type, HTTP status, duration, and request/response sizes.
- [ ] Correlate payment/provider references, scenario code, event/job IDs, attempt number, and redacted failure class in lifecycle logs.
- [ ] Redact service/webhook secrets, checkout tokens/URLs, signature/body bytes, personal data, and unbounded API responses.
- [ ] Provide trusted-network diagnostic counts for pending provider payments, due/failed/skipped events, Workmatic dead jobs, oldest undelivered event, webhook attempts, and SQLite capacity.
- [ ] Keep diagnostic output free of payment capability tokens and secrets.
- [ ] Document that API `2xx` acknowledges a webhook, provider success can coexist with webhook failure, and the API may later reconcile missed or rejected webhooks.

## 9. Automated test gates — check only after passing

- [ ] **Static/build:** lint, strict typecheck, production build, lockfile integrity, no committed secrets, Alpine container build, and runtime SQLite module load pass.
- [ ] **Migration constraints:** real file-backed SQLite enforces unique references/event IDs/attempt numbers, checks, foreign keys, WAL, and busy timeout on all connections.
- [ ] **Seed and startup:** scenario seeds are idempotent; Workmatic tables initialize in the same provider DB; bad path/schema fails before listening.
- [ ] **Service auth:** missing/wrong service Bearer token fails for initialization, status lookup, and catalogue; user Bearer token is not accepted.
- [ ] **Input validation:** bad reference, zero/overflow amount, wrong currency, bad cutoff, unknown/inactive scenario, unknown fields, malformed/oversize JSON, and bad browser outcome fields fail safely.
- [ ] **Initialization idempotency:** `201` new, `200` exact replay with same URL/reference, `409` changed details, and concurrent same-reference requests produce one row.
- [ ] **Initialization scenarios:** `PROVIDER_001` first times out/looks absent then resolves to one payment; `PROVIDER_002` creates none; a test proxy drops a committed response and lookup recovers the same row.
- [ ] **Browser UI:** iframe and standalone tab show trusted amount/actions, keyboard and readable states, terminal replay, conflicting action rejection, expiry, and no token/path leak.
- [ ] **Browser hint:** only the exact configured frontend origin receives the reference-only `postMessage` after provider commit; frontend refetches API state.
- [ ] **Atomic outcome:** payment terminal state and event/dispatch intent commit together; database rollback leaves neither half applied.
- [ ] **Outbox crash windows:** crash before enqueue is swept on restart; crash after enqueue may duplicate webhook jobs but not provider outcome or API fulfilment.
- [ ] **Same-file concurrency:** Knex and Workmatic writers survive bounded `SQLITE_BUSY` and lease replay without lost event or partial transaction.
- [ ] **HMAC contract:** signed exact raw body, stable event ID/bytes on retry, altered-byte signature scenario, invalid signature rejection, and malformed signed JSON pass.
- [ ] **Webhook retries:** 2xx stops, retryable network/timeout/5xx/408/429 gets five rounds with 2/4/8/16-second delays, permanent 4xx stops, and exhaustion remains inspectable.
- [ ] **Attempt accounting:** every HTTP submission, including concurrent duplicates and replay, has a distinct number and bounded/redacted response evidence.
- [ ] **Event states:** `delivered`, `failed`, and `skipped` match actual delivery outcomes and are independent of provider payment status and Workmatic done/dead.
- [ ] **Scenario matrix:** all ten seeded codes produce their specified timing, duplicate count/order, skip, conflict, amount change, signature, or malformed-body behavior.
- [ ] **Catalogue/snapshot:** only active scenarios are returned in stable order and reseeding does not change a payment's behavior.
- [ ] **Compose end-to-end:** real frontend/API/provider success, failure, cancellation, iframe/new-tab flow, duplicate webhook with one fulfilment, missing/bad webhook reconciliation, and conflict incident pass.
- [ ] **Recovery end-to-end:** provider/API outage, timeout, dropped response, restart, expired checkout, and isolated late-success discrepancy fixture preserve the agreed states.
- [ ] Assert provider and API database state, Workmatic job state, webhook attempts, browser result, and structured logs rather than only HTTP codes.
- [ ] Use disposable file-backed DBs and Compose volumes; never mutate a developer's persistent provider database during tests.
- [ ] Record each test command, result, and unrun suite; do not call a build or unit-only run acceptance.

## 10. Deployment gates — complete in order

- [ ] **D1 Configuration:** validate fixed internal API webhook URL, service/webhook secrets, provider public and frontend origins, DB path, worker/HTTP timeouts, lease ordering, and trusted host binding.
- [ ] **D1 Exposure:** confirm no arbitrary callback, public service-auth route, browser token leak, or secret in image/public config.
- [ ] **D2 Base image:** use an exact patch-pinned Alpine Node image, record/review digest, and build native SQLite dependencies against runtime Alpine/musl.
- [ ] **D2 Artifact:** reproduce Yarn install/build, smoke-start non-root image with only provider DB volume writable, and pass static/unit/integration/contract gates.
- [ ] **D3 Persistence:** verify local volume ownership, free space, SQLite-safe pre-upgrade backup, provider `up` migrations/seeds, and same-file Workmatic initialization.
- [ ] **D3 Migration policy:** never run production `down` migrations or mutate another service's database.
- [ ] **D4 Readiness:** verify one provider container, internal liveness/readiness, schema/worker status, API-to-provider Bearer contract, browser payment page, and frontend iframe framing.
- [ ] **D4 Outage behavior:** confirm an API webhook outage appears in diagnostics while provider outcomes/events remain durable and provider readiness stays valid.
- [ ] **D5 Functional smoke:** initialize, replay reference, complete Pay/Fail/Cancel on separate attempts, inspect status and signed webhook, and verify frontend API-state refresh after hint.
- [ ] **D6 Recovery/scenario smoke:** exercise pre-persistence delay, test-proxy lost response, duplicate/conflicting/bad/missing/delayed webhook, API outage/recovery, event/job restart recovery, and browser expiry.
- [ ] **D6 Integrity:** verify one provider payment per reference and no API double fulfilment or terminal-state overwrite in recovery tests.
- [ ] **D7 README:** explain local start/stop, migrations/seeds, origins/secrets, checkout/scenario walkthrough, test commands, request/event/job tracing, failed-event inspection, retention/capacity, SQLite backup/restore, and disposable-volume reset.
- [ ] Record every deployment gate result and every unrun check before acceptance.
- [ ] On failed rollout, preserve provider DB/logs; use prior image only if schema-compatible or restore a verified pre-upgrade backup into an isolated volume.
- [ ] Never delete the persistent provider volume as rollback; keep the service simulated with no card-data collection or real settlement.

## 11. Cross-service contract verification

- [ ] Before integration acceptance, verify the API Service document/checklist and implementation use `POST /payments/initialise` instead of `POST /payments`.
- [ ] Verify the API passes one immutable `checkout_expires_at` and treats provider HTTP `500` as a retryable initialization result.
- [ ] Verify API read-only status lookup uses `GET /payments/:reference` and treats `404` during delayed initialization as unresolved, not terminal failure.
- [ ] Verify the frontend validates the provider URL origin, permits the provider iframe, treats `postMessage` as a hint, and refetches API payment state.
