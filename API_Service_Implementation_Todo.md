# API Service Implementation Checklist

Source of truth: [API_Service_Implementation.md](API_Service_Implementation.md). Check a task only when its implementation and relevant verification are complete. Keep test and deployment gates unchecked until they actually pass; record skipped or blocked gates rather than treating them as complete. This checklist covers the API Service and the contracts it needs from other services, not the implementation of those other services.

## 1. Workspace and service foundation

- [ ] Create the API Service Yarn workspace with TypeScript strict mode and an Express application entry point.
- [ ] Add workspace scripts for `lint`, `typecheck`, `test`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, and `build`; make every `test:*` script select its named Japa v5 suite through one entry point.
- [ ] Add API-owned Knex CLI scripts for `migrate:up` and local/test-only `migrate:down`; connect them to the root Commander migration orchestration.
- [ ] Separate routes, VineJS validators, domain services, raw-SQL repositories, provider/queue clients, background jobs, configuration, and logging.
- [ ] Ensure API runtime code reads and writes only `api.db`, never another service's SQLite file.
- [ ] Add a typed `Exception`, a consistent `data`/`meta` success envelope, and an `error.code`/`error.message`/`details`/`request_id` error envelope.
- [ ] Add one global JSON error middleware that handles VineJS errors, expected HTTP errors, and unexpected errors without exposing stack traces or secrets.
- [ ] Verify rejected asynchronous Express handlers reach the global error middleware.
- [ ] Define the HTTP status mapping for invalid syntax, authentication, authorization, missing resources, state/idempotency conflicts, inconsistent provider evidence, and temporary failures.

## 2. Configuration, database connection, and lifecycle

- [ ] Validate `NODE_ENV`, `PORT`, `API_DB_PATH`, `FRONTEND_ORIGIN`, `DOCS_ORIGIN`, `PROVIDER_BASE_URL`, `PROVIDER_WEBHOOK_SECRET`, `PROVIDER_SERVICE_SECRET`, `QUEUE_BASE_URL`, and `QUEUE_SERVICE_SECRET` before listening.
- [ ] Reject missing or weak secrets, invalid origins/URLs, and a database path outside the mounted API data directory.
- [ ] Load secrets only from runtime environment or mounted secret files; keep them out of seeds, images, repository files, responses, and logs.
- [ ] Configure the 12-hour token lifetime, 5-second provider timeout, three provider-init attempts with 1-second initial backoff, and three SQLite-lock attempts with 100-millisecond initial backoff.
- [ ] Configure reconciliation every 60 seconds after a 30-second grace period, outbox dispatch every 5 seconds, batch size 100, and payment expiry at 30 days.
- [ ] Make intervals, attempt limits, and backoff configurable and deterministic under tests; bound backoff and add jitter in runtime.
- [ ] Store and compare timestamps in UTC.
- [ ] Enable and verify SQLite foreign keys on every connection, WAL mode, and a finite busy timeout.
- [ ] Implement `GET /health/live` for process liveness.
- [ ] Implement `GET /health/ready` for validated config, database access, and expected API migration version.
- [ ] Keep readiness independent of provider/queue outages while reporting those outages in diagnostics and logs.
- [ ] Restrict health endpoints to the trusted Compose network or host loopback.
- [ ] Implement bounded graceful shutdown: stop new requests, close SSE clients, finish or roll back in-flight transactions, and preserve recoverable scheduled work.

## 3. `api.db` migrations and seed data

- [ ] Create the architecture's `users`, `user_tokens`, `products`, `carts`, `cart_items`, and `payments` tables with their foreign keys, checks, timestamps, and indexes.
- [ ] Enforce case-insensitive unique user email; index token hash, expiry, and user ID.
- [ ] Enforce nonnegative on-hand `products.stock_quantity`; keep product price, currency, and active state server-owned.
- [ ] Keep product creation and mutation outside the API's public route set; use repeatable seed data for the demo catalogue.
- [ ] Support `active`, `checked_out`, `paid`, and `abandoned` cart states; add nullable `paid_at` and `checked_out_at` timestamps.
- [ ] Add the partial unique index allowing at most one active cart per user.
- [ ] Enforce unique `(cart_id, product_id)` and positive `cart_items.quantity`; preserve checkout price/currency snapshots.
- [ ] Add nullable payment URL, provider-initialisation state/retry metadata, failure-scenario code, and `reconcile_after` to `payments`.
- [ ] Enforce unique payment reference, positive checkout amount, and at most one pending payment per cart with a partial unique index.
- [ ] Add payment indexes for owner pagination, cart attempts, reconciliation, and expiry scans.
- [ ] Create `checkout_requests` with unique `(user_id, idempotency_key)`, canonical fingerprint, cart ID, payment ID, and creation time.
- [ ] Create `stock_reservations` with unique `(payment_id, product_id)`, positive quantity, and active/consumed/released states.
- [ ] Create `fulfillments` and `fulfillment_items` with unique payment and cart fulfilment constraints and purchased-item snapshots.
- [ ] Create `provider_events` for webhook/reconciliation evidence, unique webhook event ID, payload/response hash, reference, outcome, and timestamps.
- [ ] Create deduplicated `payment_incidents` with trusted reference/payment linkage, redacted details, code, and resolution timestamp.
- [ ] Create `notification_outbox` with a unique stable queue job key, payload, attempts, next-attempt time, lease, accepted time, and redacted last error.
- [ ] Add a migration path that safely rebuilds the SQLite carts table if its status check must change.
- [ ] Seed at least one active user, one active admin, and purchasable products; make seeding repeatable without overwriting payments or tokens.
- [ ] Use Knex schema methods only in migrations and parameterized `knex.raw` with named value bindings for runtime queries.

## 4. Transaction and domain invariants

- [ ] Implement a pinned-connection `BEGIN IMMEDIATE` helper with commit/rollback on that same connection; do not nest it inside a Knex-managed transaction.
- [ ] Retry the entire safe transaction on transient SQLite lock failures within the configured bound.
- [ ] Use conditional updates, unique constraints, and affected-row checks to enforce one payment transition and one fulfilment.
- [ ] Keep provider/queue HTTP calls and SSE writes outside SQLite transactions.
- [ ] Treat all amounts as integer minor units, check safe-integer multiplication/addition, and reject zero, negative, overflowed, or mixed-currency checkout totals.
- [ ] Define and enforce payment transitions from `pending` to one terminal state; never overwrite `success`, `failed`, or `cancelled`.
- [ ] Define stock availability as on-hand quantity minus active reservations; reserve at checkout, consume on success, and release on failure/cancellation.
- [ ] Make a paid cart immutable and ineligible for another checkout; allow an unsuccessful checked-out cart to start a new attempt.

## 5. Authentication, authorization, and public routes

- [ ] Implement `GET /v1/demo/users` with active seeded IDs, names, and roles only.
- [ ] Implement `POST /v1/login` for a seeded `user_id`, generating a cryptographically random opaque token and storing only its SHA-256 hash.
- [ ] Enforce token expiry, revocation, and active-user checks on every protected request.
- [ ] Implement `POST /v1/logout` to revoke the current token safely on repeated calls.
- [ ] Add Bearer middleware, request-context user/role injection, and explicit admin guards where needed.
- [ ] Scope cart, payment, and SSE data to the owner; allow admins system-wide payment reads without leaking other users' SSE events.
- [ ] Return `404` rather than disclosing another user's payment by ID.
- [ ] Treat login, demo-user discovery, OpenAPI JSON, health, and provider-HMAC webhook as explicit exceptions to user Bearer authentication.
- [ ] Apply CORS only for configured frontend/documentation origins and required methods/headers; do not rely on CORS for authorization.
- [ ] Ensure no client PUT/PATCH endpoint can set payment status.

## 6. Products, carts, and failure-scenario discovery

- [ ] Implement `GET /v1/products` for active products with stable pagination, default page size 20, maximum 100, totals, and available stock.
- [ ] Implement `GET /v1/cart` for the caller's active cart or `data: null`.
- [ ] Implement `POST /v1/cart` to create/reuse the one active cart and add validated product quantities.
- [ ] Implement `PATCH /v1/cart/items/:product_id` to set a positive active-cart quantity.
- [ ] Implement `DELETE /v1/cart/items/:product_id` to remove an active-cart item and return `204`.
- [ ] Implement `DELETE /v1/cart` to abandon only an active cart and return `204`.
- [ ] Recompute active-cart totals from persisted server prices after each edit; reject inactive products, currency mismatch, and unavailable quantity.
- [ ] Implement `GET /v1/carts/:cart_id` for owner/admin access to cart items and payment attempts, including retry and page-refresh use.
- [ ] Implement `GET /v1/failure-scenarios` using the provider's active catalogue, returning `503` when unavailable.
- [ ] Validate checkout scenario codes against that catalogue and pass only the selected code to the provider.

## 7. Checkout, idempotency, and provider initialisation

- [ ] Require and validate a bounded `Idempotency-Key` for `POST /v1/cart/checkout`; validate optional cart ID and scenario code.
- [ ] Persist a canonical user/cart/scenario request fingerprint and the key-to-payment mapping.
- [ ] Resolve a replay with omitted `cart_id` through its stored mapping; return the same attempt for the same key and `409` for a changed fingerprint.
- [ ] Select the active cart, an explicitly selected checked-out cart, or the sole pending checked-out cart when no cart ID is supplied; require cart ID if selection is ambiguous.
- [ ] Under `BEGIN IMMEDIATE`, verify ownership, cart state, items, active products, available stock, currency, and positive server-calculated total.
- [ ] Reuse an existing pending payment for a compatible new key; prevent a second pending payment and reservation set for the cart.
- [ ] For a new attempt, create one unique reference, immutable amount/item snapshots, reservations, pending payment, and idempotency mapping in one transaction.
- [ ] Mark an active cart checked out at first attempt; keep a failed/cancelled cart available for a new attempt with a **new** key/reference.
- [ ] Call idempotent provider `POST /payments` outside the transaction with reference, amount, currency, and selected scenario.
- [ ] Apply provider timeout, bounded transient retries, exponential backoff, and permanent-error classification.
- [ ] Persist a returned provider URL; reject any client-supplied URL or arbitrary-host redirect.
- [ ] After a lost provider response, query by reference and recover URL/outcome or retry with the **same** reference.
- [ ] Return `201` for a new ready attempt, `200` for replay/existing ready attempt, or `202` for unresolved initialisation with a visible reference and scheduled recovery.
- [ ] On proven permanent provider rejection, mark the attempt failed, release reservations, and create notification intents; keep uncertain temporary outcomes pending.
- [ ] Prevent a paid cart from starting a new attempt.

## 8. Signed webhooks, transitions, and fulfilment

- [ ] Capture the exact raw webhook body under a small body-size limit and verify HMAC-SHA-256 in constant time before parsing.
- [ ] Validate `event_id`, event type/status, reference, amount, currency, and optional provider transaction reference.
- [ ] Compare signed reference, amount, and currency with the pending local payment; reject malformed, mismatched, and unauthenticated requests with the documented status codes.
- [ ] Persist event receipt and payment transition atomically; reject the same event ID with a different body hash.
- [ ] For success, atomically mark payment successful, create one fulfilment and item set, decrement on-hand stock, consume reservations, mark cart paid, set `paid_at`, and insert notification intents.
- [ ] For failure/cancellation, atomically mark payment terminal, release reservations, and insert notification intents.
- [ ] Acknowledge identical duplicates with `200` without repeating fulfilment, stock changes, or notifications.
- [ ] Record distinct conflicting terminal events as incidents, keep the terminal state, and acknowledge them with `200`.
- [ ] Return a retryable `503` after transaction rollback/lock exhaustion and `200` only after durable processing.
- [ ] Recover safely from a crash after commit but before webhook acknowledgement.

## 9. Reconciliation, expiry, and incidents

- [ ] Run bounded periodic scans of due pending payments after the webhook grace period; claim work so overlapping ticks cannot duplicate processing.
- [ ] Query provider status by immutable reference with service authentication, timeout, and response validation for reference/amount/currency.
- [ ] Route provider-confirmed terminal status through the same transactional transition and fulfilment path as a webhook, with distinct evidence provenance.
- [ ] Reschedule provider-pending or temporarily failed lookups with bounded backoff; never change payment status on an unavailable/ambiguous lookup.
- [ ] At day 30, perform a fresh provider lookup before attempting expiry.
- [ ] If the day-30 provider result is pending, conditionally fail the API payment, release reservations, record notification intents, and log that provider cancellation was not confirmed.
- [ ] If the day-30 lookup is unavailable, retain pending status and stock reservation, deduplicate an incident/admin alert, and retry later.
- [ ] Make a concurrent webhook and expiry update compete through a conditional transition so exactly one wins.
- [ ] For success reported after API expiry, keep `failed` terminal, create one discrepancy, alert admins, and do not fulfil or adjust stock.
- [ ] Expose unresolved pending payments, old reservations, and late-success incidents through trusted diagnostics and logs.

## 10. Notification outbox and SSE

- [ ] Create user-email intents for successful, failed, and cancelled payments in the payment transaction.
- [ ] Create deduplicated admin-email intents for payment-integrity incidents, invalid-signature scenarios, unresolved day-30 lookups, and late-success discrepancies.
- [ ] Implement an API-owned outbox dispatcher that atomically claims due rows and submits authenticated `POST /jobs` requests with stable `notification_key` correlation values.
- [ ] Mark a row accepted only after the queue confirms durable acceptance; retry timeouts/outages with bounded backoff and retained rows.
- [ ] Keep one durable API notification intent across dispatcher retries; document and test that a lost queue acknowledgement or worker replay may create a duplicate job/email without changing payment fulfilment.
- [ ] Implement `GET /v1/events` as a Bearer-authenticated SSE stream with owner-scoped status events, heartbeat, and disconnect cleanup.
- [ ] Publish SSE only after payment commit; keep payment outcome independent of SSE or email failure.
- [ ] Include payment ID, reference, status, and request/event ID in SSE events without leaking another user's data to admin streams.
- [ ] Support client reconnect by making `GET /v1/payments/:payment_id` authoritative for current state; do not put Bearer tokens in SSE URLs.

## 11. Security, logging, diagnostics, and OpenAPI

- [ ] Use fixed configured internal service URLs and authenticated outbound provider/queue calls; block arbitrary-host redirects or server-side request targets.
- [ ] Validate and bound JSON bodies, path/query/header inputs, IDs, page sizes, quantities, idempotency keys, and scenario codes with VineJS.
- [ ] Use named SQL value bindings throughout runtime code and avoid interpolating request data into SQL.
- [ ] Add AsyncLocalStorage request context for validated/generated request ID, authenticated user, and role.
- [ ] Add Pino lifecycle logs with method, path, status, auth state, user ID/role, timing, request size, and response size.
- [ ] Include request ID, payment reference, retry attempt, and redacted failure reason in checkout, webhook, job, and incident logs.
- [ ] Redact Bearer tokens, service secrets, full webhook bodies, and unnecessary personal data from logs and errors.
- [ ] Expose trusted diagnostic counts for checkout creation/replay/conflict, webhook duplicate/conflict/rejection, reconciliation results, pending age, outbox backlog, queue failures, and reservation age.
- [ ] Create and validate versioned OpenAPI JSON at public `GET /v1/api_docs.json`, including all routes, auth schemes, error shapes, SSE, and examples.
- [ ] Document the absent manual payment-status endpoint and demo-only passwordless login in the root README/OpenAPI narrative.

## 12. Automated test gates — complete only after passing

- [ ] Pin an exact `@japa/runner` 5.x release and compatible `@japa/assert` and `@japa/api-client` versions in the Yarn lockfile; use no legacy `japa` runner.
- [ ] Create an ESM `bin/test.ts` using Japa `processCLIArgs`, `configure`, and `run`, with an ESM-compatible TypeScript executor for the pinned Node version.
- [ ] Configure named Japa `unit`, `integration`, `contract`, and `e2e` suites; prove `test` runs all and each `test:*` script selects exactly one suite.
- [ ] Use Japa assertions and lifecycle hooks to create/clean deterministic fixtures, isolated temporary SQLite files, and an ephemeral Express listener for Japa API-client HTTP tests.
- [ ] Run migration checks in Japa `integration`, provider/queue and OpenAPI checks in `contract`, and real disposable Compose/child-process/proxy recovery checks in `e2e`.
- [ ] **Static/build:** lint, strict typecheck, production build, lockfile consistency, secret scan, and OpenAPI validation all pass with zero failures.
- [ ] **Migration/seed:** fresh `up`, repeatable seed, disposable-data `down` and second `up` pass; real SQLite files prove foreign keys, checks, unique/partial indexes, and schema version.
- [ ] **Migration safety:** production `down` is rejected and seed reruns never overwrite runtime payments/tokens.
- [ ] **Unit:** VineJS boundaries, money arithmetic/overflow, idempotency fingerprints, token hash/expiry/revocation, HMAC checks, transition matrix, retry/backoff, and error mapping pass with deterministic time.
- [ ] **HTTP integration:** success/error envelopes, authentication, roles, ownership, pagination, cart CRUD, idempotency conflicts, OpenAPI, and health pass against temporary SQLite files.
- [ ] **HTTP integrity:** no client PUT/PATCH payment-status route exists; public/Bearer/HMAC route boundaries and user-data isolation pass.
- [ ] **Checkout concurrency:** simultaneous checkout and key replay produce one pending reference and reservation set; compatible new key reuses pending attempt; new key after failure creates exactly one new attempt.
- [ ] **Stock/fulfilment:** competing carts cannot oversell; failure/cancellation releases stock; success consumes once and creates one fulfilment; invalid carts and unsafe totals fail.
- [ ] **Provider initialisation:** timeout, `503`, response loss after creation, permanent rejection, restart, and same-reference recovery pass without a second provider payment or an open DB transaction during HTTP.
- [ ] **Webhook:** success/failure/cancellation, sequential/concurrent duplicates, altered duplicate ID, conflicting terminal event, wrong reference/amount/currency, bad signature, malformed body, and rollback return the specified outcomes.
- [ ] **Webhook crash recovery:** replay after commit-before-ack creates no second fulfilment, stock change, or outbox intent.
- [ ] **Reconciliation/expiry:** missing webhook recovery, provider outage, day-30 pending result, concurrent expiry/webhook, and late success produce the specified terminal state, reservation, incident, and admin alert.
- [ ] **Outbox/SSE:** queue outage, lost acknowledgement, duplicate dispatcher tick, API restart, possible duplicate queue job/email, SSE disconnect/reconnect, and event isolation pass without changing the one API intent or committed payment state.
- [ ] **Contract:** OpenAPI examples match real API responses; provider init/status/webhook fixtures and queue job acceptance, correlation key, and possible duplicate-submission fixtures match their declared contracts.
- [ ] **Compose end-to-end:** real containers pass login → cart → checkout → provider completion → webhook → paid cart/fulfilment/stock/email/SSE, with final database and log assertions.
- [ ] **Compose failure end-to-end:** duplicate webhook, provider timeout, missed webhook reconciliation, invalid signature, and queue outage/recovery pass with final-state assertions.
- [ ] Record gate commands/results and every skipped or blocked suite; do not use a coverage percentage as a substitute for concurrency or crash tests.

## 13. API deployment gates — complete in order

- [ ] **D1 Configuration:** restrict API and health exposure to trusted network/host loopback; set non-default runtime secrets, allowed origins, fixed internal URLs, and persistent `api.db` mount.
- [ ] **D1 Configuration:** verify no secrets are committed, baked into the image, or emitted in logs/responses.
- [ ] **D2 Artifact:** use a small exact patch-pinned Alpine Node base image; record/review its digest and dependency lockfile; avoid moving `latest` tags.
- [ ] **D2 Artifact:** build a multi-stage image with production-only runtime dependencies, non-root user, writable API data mount, and health check.
- [ ] **D2 Artifact:** reproduce Yarn install/build, smoke-start the image, and confirm static, unit, integration, and contract gates are green; complete Compose end-to-end gates at D5/D6.
- [ ] **D3 Persistence:** verify API volume ownership and available space; take a SQLite-safe pre-migration backup when a database already exists.
- [ ] **D3 Persistence:** run API `up` migration once before API startup; prohibit deployment-time `down`.
- [ ] **D4 Readiness:** start the one API container after migrations and verify `/health/ready` confirms schema/database health.
- [ ] **D4 Dependencies:** verify provider and queue endpoints/auth contracts are reachable for checkout and notification smoke tests.
- [ ] **D5 Functional smoke:** verify seeded login, product/cart reads, checkout, provider-confirmed completion, payment read, one fulfilment, stock decrement, outbox acceptance, SSE, and OpenAPI fetch in Compose.
- [ ] **D6 Recovery smoke:** replay checkout key and webhook; interrupt/restore provider and queue; verify no duplicate payment/fulfilment and eventual reconciliation/outbox drain.
- [ ] **D6 Security smoke:** reject and log an invalid webhook signature without changing payment state.
- [ ] **D7 Operations:** document local start/stop, migrations, disposable seed/reset, configuration, scenario walkthrough, test commands, request-ID tracing, backup/restore, and manual late-success resolution in README.
- [ ] **D7 Operations:** record every deployment-gate result and any unrun check; do not expose the API if a pre-traffic gate fails.
- [ ] Prepare rollback: preserve database/logs, restore a previous image only if schema-compatible, otherwise restore the verified pre-migration backup into an isolated volume; never use production `down`.
- [ ] Restrict full local reset to an explicitly disposable demo volume.

## 14. Required cross-service contracts (API integration blockers)

- [ ] Confirm provider `POST /payments` is idempotent by reference and details, with conflict rejection for changed details.
- [ ] Confirm authenticated provider `GET /payments/:reference` returns reference, amount, currency, status, and URL when available.
- [ ] Confirm the provider exposes an active failure-scenario catalogue and signs raw webhook bodies with stable `event_id` values; delivery retries `503`/network failures and stops on `2xx` or permanent `4xx`.
- [ ] Confirm authenticated queue `POST /jobs` durably accepts each call, treats `notification_key` as correlation metadata, may create a second job/email after an uncertain retry, and distinguishes acceptance from temporary failure.
- [ ] Confirm the frontend sends Bearer tokens and checkout idempotency keys, keeps a key for HTTP retries, uses a new key for a new attempt, opens an Authorization-capable SSE stream, and refetches payment state after reconnect.
- [ ] Confirm the documentation service can fetch public `/v1/api_docs.json` from its allowed CORS origin and represents Bearer and webhook-HMAC authentication separately.
- [ ] Block API integration acceptance if any required provider/queue contract is absent; do not compensate by reading another service's database or weakening API invariants.
