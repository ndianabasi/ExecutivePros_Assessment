# API Service Implementation Document

## 1. Purpose and boundary

This document specifies the **API Service only** in [System_Architecture.md](System_Architecture.md). It is the implementation contract for its TypeScript/Node.js Express application, its `api.db` schema, its HTTP and SSE interfaces, its background work, and its test and deployment gates. The Mock Payment Provider and Message Queue Service are dependencies; their internal implementation belongs in their own documents.

The deployment target is a **trusted assessment demo**, not a public payment system. Passwordless selection of seeded users, including admins, is permitted only in that environment. The API must still validate authorization, payment evidence, money, stock, and state transitions as though requests were hostile. The container must not be exposed on an untrusted public interface.

The assessment asks for a PUT/PATCH payment-status endpoint. The architecture and the discussion deliberately exclude one: clients cannot set payment status. Status changes come from authenticated provider webhooks, authenticated provider status reconciliation, or the 30-day expiry job. Document this deviation from the assessment brief in the root README and demonstrate status changes through the simulated provider.

### Settled decisions

| Area | Required behavior |
| --- | --- |
| Fulfilment | A successful payment creates one durable purchase/fulfilment record, marks the cart paid, and consumes reserved stock in one `api.db` transaction. |
| Cart retries | A failed or cancelled attempt releases its reservation. The same checked-out cart may be retried with a new payment reference; a paid cart may not. |
| Checkout replay | `Idempotency-Key` is required. Reusing a key returns the same attempt. A new key after terminal failure/cancellation starts a new attempt. |
| Notifications | Transactionally record notification intents in an API-owned outbox. Dispatch to the Message Queue Service with a stable `notification_key` for correlation; a lost queue acknowledgement can create a duplicate job/email. |
| Missed webhooks | Periodically reconcile pending payments against the provider, using the same state-transition/fulfilment path as a webhook. |
| Day-30 expiry | Check provider status. If it reports success, failed, or cancelled, apply that outcome. If it reports pending, mark the API payment failed **without provider cancellation**. If lookup is unavailable, leave it pending and alert admins. |
| Late success after expiry | Keep the API's failed state terminal, do not fulfil, persist a discrepancy, and alert admins for manual resolution. This is an explicit limitation of the chosen expiry policy. |

## 2. Service layout and implementation order

Create one Yarn workspace for the API Service within the monorepo. Use TypeScript with strict type checking, Express, VineJS request validation, Knex for migrations and `knex.raw` SQL outside migrations, and Pino for structured logging. Keep HTTP routing, validation, domain services, SQL repositories, provider/queue clients, background jobs, and configuration separate. Do not let route handlers construct ad hoc SQL or call other services while holding a database transaction. Expose API-owned `migrate:up` and local/test-only `migrate:down` scripts through the Knex CLI; the root Commander migration command may orchestrate them, but the API owns only its migrations.

Implement in this order so each slice can be verified before the next:

1. Workspace scripts, configuration validation, logger/request context, error envelope, SQLite connection, migrations, seed data, and health endpoints.
2. Demo login/logout and authorization; products and active-cart CRUD.
3. Checkout transaction, stock reservations, idempotency mapping, provider initialisation, and recovery of an uncertain provider response.
4. Signed webhook intake, payment transitions, fulfilment, incidents, and read APIs.
5. Notification outbox, SSE, periodic reconciliation, and day-30 expiry.
6. OpenAPI JSON, automated gates, Docker image, Compose integration, and operational README.

Only `api.db` is read or written by the API Service. The shared Docker volume described by the architecture must not be used to query another service's database directly.

## 3. Configuration, startup, and health

Validate configuration before listening. Required settings: `NODE_ENV`, `PORT`, `API_DB_PATH`, `FRONTEND_ORIGIN`, `DOCS_ORIGIN`, `PROVIDER_BASE_URL`, `PROVIDER_WEBHOOK_SECRET`, `PROVIDER_SERVICE_SECRET`, `QUEUE_BASE_URL`, and `QUEUE_SERVICE_SECRET`. Secrets must come from runtime environment or mounted secret files, never seed files, images, logs, or the repository. Fail startup for missing or weak secrets, invalid URLs, or a database path outside the mounted data directory.

Configurable defaults for the demo: bearer-token lifetime 12 hours; provider request timeout 5 seconds; provider initialisation 3 attempts with 1-second exponential starting delay; SQLite transient-lock retry 3 attempts with 100-millisecond starting delay; reconciliation every 60 seconds for payments pending at least 30 seconds; outbox dispatch every 5 seconds; batch size 100; payment expiry at 30 days. Bound exponential backoff and add jitter. Make job intervals and limits overridable for fast deterministic tests. Record dates in UTC.

Enable SQLite foreign keys on **every connection**, set a finite busy timeout, and use WAL mode on the local persistent volume. Verify the actual pragma values at startup. `GET /health/live` reports that the process is running. `GET /health/ready` succeeds only after config, database connection, and expected API migration version are valid. Queue/provider outages are reported in logs and dependency diagnostics but do not make a process with working payment reads and webhook intake unready. Bind health access to the trusted Compose network or host loopback.

The API container runs as a non-root user with only its `api.db` directory writable. There is one API container; scheduled work runs in that process. Shutdown stops new requests, releases SSE clients, lets in-flight transactions finish within a bounded grace period, and leaves outbox/reconciliation state recoverable after restart.

## 4. `api.db` schema and invariants

Keep the architecture's `users`, `user_tokens`, `products`, `carts`, `cart_items`, and `payments` tables. Implement foreign keys and checks as specified there, with these refinements and additions. Migrations are owned by the API workspace under `database/migrations`; use Knex schema methods in migrations only. Runtime SQL uses parameterized `knex.raw` with named value bindings.

| Table/change | Fields and constraints needed for the API contract |
| --- | --- |
| `users` / `user_tokens` | Seed users and roles; case-insensitive unique email; hash opaque tokens with SHA-256; index token expiry and user ID. Revoke individual tokens on logout. |
| `products` | `stock_quantity` means on-hand stock. Product prices, currency, and active status are server-owned. Seed a known catalogue; no product mutation API. |
| `carts` | Add `paid` to status (`active`, `checked_out`, `paid`, `abandoned`) and nullable `paid_at`. Enforce at most one active cart per user with a partial unique index. A checked-out cart is immutable and can be retried only after its latest attempt is terminal and unsuccessful. |
| `cart_items` | Unique `(cart_id, product_id)`; positive integer quantity; add currency if needed for the unit-price snapshot at checkout. Active-cart edits must recompute the cart total from server prices. |
| `payments` | Amount must be **positive** at checkout; reference unique. Add nullable `payment_url`, provider-initialisation state and retry metadata, `failure_scenario_code`, and a `reconcile_after` timestamp. Enforce at most one pending payment per cart with a partial unique index. Add indexes for `(user_id, created_at, id)`, `(cart_id, created_at)`, and pending reconciliation/expiry scans. |
| `checkout_requests` | Unique `(user_id, idempotency_key)`; store canonical request fingerprint, cart ID, payment ID, and created time. Same key with a different fingerprint returns `409`. A record remains linked to its payment after terminal status. |
| `stock_reservations` | Unique `(payment_id, product_id)` with quantity and `active`, `consumed`, or `released` state. Available stock is on-hand stock minus active reservations. A failed/cancelled payment releases its reservation; success decrements on-hand stock and consumes it in the same transaction. |
| `fulfillments` / `fulfillment_items` | Unique payment ID **and** cart ID; store user, payment, cart, timestamp, and purchased product/quantity/price snapshots. These rows are the simulated value granted to the user. They are created atomically with success status, cart `paid`, stock decrement, and outbox intents. |
| `provider_events` | Evidence source (`webhook` or `reconciliation`), nullable unique provider `event_id` for webhooks, raw-body or status-response SHA-256, reference, outcome, and timestamps. Accepted evidence insertion and its payment transition share a transaction. The same webhook event ID with different content is a permanent conflict. |
| `payment_incidents` | Durable, deduplicated record for amount/currency mismatch, invalid state, late success, unresolved provider status, or another manual-resolution condition; include payment/reference where trusted, code, redacted details, and resolution timestamp. |
| `notification_outbox` | Unique stable queue job key derived from `(payment_reference, notification_type, recipient)`; payload, attempts, `next_attempt_at`, lease, accepted timestamp, and last redacted error. An incident without a trusted payment reference derives its unique key from its incident ID, type, and recipient. |

Migrations must create the partial indexes and rebuild the SQLite `carts` table if required to extend its status check. Migration tests must verify constraints with actual SQLite files, not only inspect generated SQL. Seeds must be idempotent, contain at least one active user and admin plus purchasable products, and never overwrite runtime payments or tokens.

### Transaction rules

Use a single pinned SQLite connection for each `BEGIN IMMEDIATE` checkout or payment-transition transaction; commit or roll back on that same connection. Do not nest a Knex-managed transaction around a manual `BEGIN IMMEDIATE`. The transaction must include all state changes that determine whether value was granted. Use unique indexes and conditional updates as the final guard, and verify affected-row counts. Keep HTTP calls and SSE writes outside transactions. SQLite permits only one writer at a time; `BEGIN IMMEDIATE` obtains the write transaction up front and can return `SQLITE_BUSY`, so retry the **whole safe transaction** within the configured bound. See [SQLite transaction control](https://www.sqlite.org/lang_transaction.html) and [Knex raw bindings](https://knexjs.org/guide/raw.html).

## 5. HTTP, SSE, and error contracts

All JSON requests are validated with VineJS, including path/query/header values. Reject unknown checkout fields and never trust client amount, currency, user ID, stock count, payment status, or provider URL. Use a common success shape (`data`, optional `meta`) and error shape (`error.code`, `error.message`, optional validation `details`, `request_id`). Return no stack traces or secret values.

| Route | Access | Contract and notable outcomes |
| --- | --- | --- |
| `GET /v1/demo/users` | Public, trusted demo only | List seeded active user IDs, names, and roles for the login selector; omit tokens and unnecessary profile data. |
| `POST /v1/login` | Public | Accept seeded `user_id`; issue cryptographically random opaque bearer token, store SHA-256 hash with expiry, return token once and minimal user profile. Reject inactive/unknown user. |
| `POST /v1/logout` | Bearer | Revoke only the current token; repeated logout is harmless. |
| `GET /v1/products` | Bearer | Active seeded products; `page` and `page_size` (default 20, maximum 100), stable order, total and page metadata. Include available stock, never raw reservation rows. |
| `GET /v1/cart` | Bearer | Return the caller's active cart and items, or `data: null`. |
| `POST /v1/cart` | Bearer | Create the active cart if absent and add validated `{product_id, quantity}` items; repeated products increase quantity. Reject inactive products, currency mismatch, and unavailable quantity. |
| `PATCH /v1/cart/items/:product_id` | Bearer | Set a positive quantity on the active cart and recompute total. |
| `DELETE /v1/cart/items/:product_id` | Bearer | Remove one active-cart item and recompute total; return `204`. |
| `DELETE /v1/cart` | Bearer | Mark the active cart abandoned; return `204`. A checked-out or paid cart cannot be abandoned through this route. |
| `GET /v1/carts/:cart_id` | Bearer, owner or admin | Read an active, checked-out, or paid cart, its item snapshots, and payment attempts; needed for retry and page refresh. |
| `GET /v1/failure-scenarios` | Bearer | Return active scenario codes/names/descriptions from the provider's internal catalogue; return `503` if unavailable. The API accepts only a code present in this catalogue. |
| `POST /v1/cart/checkout` | Bearer, owner | Require `Idempotency-Key`; body may select `cart_id` and `failure_scenario_code`. Without `cart_id`, use the active cart. Return `201` with payment URL for a new ready attempt, `200` for a replay/existing ready attempt, or `202` with payment reference while initialisation is unresolved. |
| `POST /v1/webhooks/payment` | Provider HMAC only | Verify raw-body signature before JSON parsing/domain processing. Accepted or identical duplicate event returns `200`; invalid signature `401`, malformed payload `400`, trusted amount/currency/reference mismatch `422`, event-ID/body collision `409`, transient processing failure `503`. No user bearer token. |
| `GET /v1/payments` | Bearer | Paginated own payments for users, all payments for admins. Stable descending creation/ID order; include cart and fulfilment summary but no private token or raw webhook payload. |
| `GET /v1/payments/:payment_id` | Bearer, owner or admin | Full payment, cart/items, fulfilment, and safe status/incident summary. Return `404` for another user's payment to avoid disclosing existence. |
| `GET /v1/events` | Bearer | SSE stream scoped to the authenticated user; status changes include payment ID, reference, status, and request/event ID. Use a fetch-based stream client that can send `Authorization`, not a token in the URL. Heartbeat and remove disconnected clients. |
| `GET /v1/api_docs.json` | Public | Serve the versioned OpenAPI document used by the documentation service. |
| `GET /health/live`, `GET /health/ready` | Trusted network | Process and readiness probes described above. |

The payment list/detail APIs must expose enough information for a client to recover state after a lost SSE event. SSE is an advisory live signal, not the source of truth or a durable replay queue. A reconnecting client reads the relevant payment again. Admins receive system-wide access through the read APIs; incidents caused by non-admin actions go to admins by email rather than another user's SSE stream.

Use Bearer authentication middleware for protected routes and an explicit admin guard where needed. The webhook has its own HMAC authentication boundary. `GET /v1/api_docs.json`, demo user discovery, and health probes are deliberate exceptions to the architecture's general “all endpoints authenticated” statement. CORS allows only configured frontend and documentation origins, with the required methods/headers; CORS is not authorization.

Use a typed `Exception` for expected HTTP errors. Put one JSON error middleware after routes; let asynchronous handler failures reach it and convert unexpected errors to `500` with a request ID. Express 5 supports rejected async-handler promises; pin the chosen major version and test this behavior. See [Express error handling](https://expressjs.com/en/guide/error-handling/). Suggested codes: `400` invalid syntax, `401` absent/invalid credential, `403` forbidden role, `404` absent resource, `409` idempotency/state/stock conflict, `422` valid but inconsistent payment evidence, `429` if a configured rate limit is applied, and `503` temporary dependency/database failure.

## 6. Payment lifecycle and recovery

### 6.1 Checkout and provider initialisation

1. Validate token, `Idempotency-Key` (bounded length and safe character set), optional cart ID, and scenario code. Check for an existing `(user, key)` mapping first; use its stored cart ID to evaluate a replay that omitted `cart_id`. Canonicalize the request fingerprint from user, resolved cart, and scenario; return the mapped payment without creating another attempt, or `409` if the fingerprint differs.
2. In `BEGIN IMMEDIATE`, choose the caller's active cart or explicitly selected checked-out cart. When `cart_id` is omitted and no active cart remains, reuse the caller's sole pending checked-out cart; if several qualify, require `cart_id`. A checked-out cart is eligible for a new attempt only when its latest attempt is `failed`/`cancelled`; a paid cart is never retryable. Verify positive item quantities, product activity, common NGN currency, and available stock. Recompute total on the server and require `amount > 0`.
3. If a pending attempt already exists, map a compatible new key to it and return that attempt. Otherwise create a unique payment reference, immutable amount/item snapshots, active reservations, a pending payment, and the checkout-key mapping. Set an active cart to `checked_out` with `checked_out_at`. Commit before any provider call.
4. Call provider `POST /payments` with the same reference, amount, currency, and selected scenario on every retry. The provider must treat same-reference/same-details requests as idempotent and reject conflicting details. Apply a 5-second timeout and at most three bounded exponential attempts for transient errors. A ready response stores the provider URL; never accept a URL from the client.
5. If the response is lost, query the provider by reference. If it has the payment, recover its URL/outcome. Otherwise retry initialisation with the **same** reference. Preserve the pending local record while the remote outcome is uncertain; return `202` and schedule recovery rather than make a second payment. A proven permanent provider rejection marks the attempt failed, releases reservations, and records notification intents; a temporary outage remains retryable and visible.

The API must not hold a SQLite write lock during remote calls. A retry with the same key after a terminal failure still returns the old attempt; creating the next attempt requires a new key. A new key while another attempt is pending must not create a second payment. Use safe-integer checks for all minor-unit amounts and multiplication; reject overflow instead of rounding a payment total.

### 6.2 Webhook authentication and transition

The provider signs the exact raw request body with HMAC-SHA-256 and a shared secret. Compare signatures in constant time, enforce a small body-size limit, and parse/validate only after signature verification. The payload needs `event_id`, event type/status, payment reference, amount, currency, and provider transaction reference if issued. The API trusts no unsigned metadata and never logs the secret or full signed body.

For a new, valid event, compare reference, amount, and currency to the local payment. Inside a single write transaction, insert the event receipt and conditionally transition `pending` to the provider's terminal status. On `success`, create fulfilment and item rows, decrement on-hand stock, consume reservations, mark the cart `paid`, set `paid_at`, and insert user/admin notification intents. On `failed` or `cancelled`, release reservations and insert notification intents. Commit before returning `200` or sending SSE.

An identical event replay returns `200` without repeating any side effect. A distinct event that conflicts with a terminal payment is recorded as an incident and acknowledged `200` to stop futile delivery retries; it never overwrites the terminal status. An event ID reused with different bytes returns `409`. Invalid signatures and malformed/incorrect monetary data are permanent errors; a rolled-back transaction or `SQLITE_BUSY` exhaustion returns `503` so the provider can retry. If the process crashes after commit but before response, the next delivery finds the committed receipt/fulfilment and returns `200`.

### 6.3 Periodic reconciliation and 30-day expiry

In the API process, scan due pending payments in bounded batches, starting after a short webhook grace period. Claim work so overlapping timer ticks do not process the same payment simultaneously. Query the provider by the immutable payment reference with service authentication and a timeout. Validate returned reference, amount, and currency. Feed a provider-confirmed `success`, `failed`, or `cancelled` through the same transactional transition function used for webhooks, with a distinct evidence/source record. If the provider still reports pending, schedule another lookup with backoff. Failed lookup is retried and logged; it must not change payment status.

At 30 days, perform a fresh provider lookup before expiry. If it reports pending, conditionally mark the API payment failed, release its reservation, record notification intents, and log that provider cancellation was **not** confirmed. If lookup is unavailable or ambiguous, keep the payment pending, retain its reservation, record/deduplicate an incident, alert admins, and retry later. A concurrent webhook can win the conditional transition; the expiry job must then do nothing.

If a signed late success or provider lookup reports success after API expiry, keep `failed` terminal. Persist a discrepancy with reference, provider status, and timestamps, and send one deduplicated admin alert. Do not automatically grant value, adjust stock, or silently change status. The README must state that manual review is required in this simulated policy. A provider outage can hold stock reservations beyond 30 days; show that backlog in diagnostics and admin alerts rather than freeing stock while payment outcome is unknown.

### 6.4 Outbox and SSE

Insert notification intents in the same transaction as their payment/incident change. The API dispatcher claims due outbox rows, sends `POST /jobs` with a stable `notification_key` composed from payment reference, notification type, and recipient (or incident key), and marks a row accepted only after a durable queue acknowledgement. On timeout or outage, reschedule with bounded backoff and retain the row. The key is correlation metadata, not queue idempotency: a lost acknowledgement can cause a second job/email. The outbox prevents lost notification intent but cannot guarantee one email. Queue delivery and Mailpit handling are outside this service's implementation; durable acceptance and the duplicate risk are required integration contract tests.

After commit, publish a best-effort SSE event to connected authorized clients. An SSE failure never rolls back a payment or resubmits a webhook. The client reconnects and retrieves state from the payment API. Email and SSE work must not run inside the payment transaction.

Notification recipients are explicit: a successful, failed, or cancelled payment creates one user-email intent; a payment-integrity incident, invalid-signature scenario, unresolved day-30 lookup, or late-success discrepancy creates one deduplicated admin-email intent. Queue or SMTP retries can still deliver more than one email per intent. The owning user also receives the appropriate payment outcome over SSE when connected. Never send another user's payment details to an admin SSE connection merely because the admin role can read system-wide payments.

## 7. Security, logging, and operational behavior

- Keep the demo API, documentation, frontend, and provider on a trusted Compose network; publish only the intended host-loopback ports. Do not describe seeded passwordless admin login as production-grade authentication.
- Generate tokens with a cryptographically secure random source; hash before storage, enforce expiry/revocation and active-user checks on every protected request, and never log raw tokens. Prefer in-memory frontend token storage for the demo; document logout and expiry behavior.
- HMAC-authenticate webhooks independently of user Bearer tokens. Authenticate outbound provider/queue calls with service credentials, use fixed configured base URLs, and reject provider URLs that would cause server-side redirects or arbitrary-host requests.
- Apply VineJS bounds to IDs, pagination, quantities, keys, and scenario codes. Derive prices and totals from persisted server data. Use named SQL bindings and never interpolate user input into SQL.
- Use AsyncLocalStorage for request ID and authenticated user context. Create/accept a validated request ID at ingress; include it and payment reference in request, retry, job, and incident logs. Redact authorization headers, secrets, webhook bodies, and personal data. Record method, path, status, user ID/role, timing, and request/response sizes in one completion log.
- Expose measurable counts for checkout creation/replay/conflict, webhook duplicate/conflict/rejection, reconciliation result, pending age, outbox backlog, queue failure, and stock reservation age. For the demo, structured logs and a diagnostic command or endpoint restricted to the trusted network are sufficient; do not expose sensitive incident data publicly.

## 8. Test gates

Each gate is mandatory for the API Service. Use **Japa v5** (`@japa/runner` 5.x, not the legacy `japa` package) as the runner for all automated unit, integration, contract, and Compose end-to-end tests. Pin one exact 5.x runner release and compatible `@japa/assert` and `@japa/api-client` releases in the Yarn lockfile; check their peer dependencies at implementation time. Use a service-owned ESM `bin/test.ts` entry point with Japa's `processCLIArgs`, `configure`, and `run`, and named `unit`, `integration`, `contract`, and `e2e` suites. Run the TypeScript entry point with an ESM-compatible executor supported by the pinned Node version. `test` runs all suites; `test:unit`, `test:integration`, `test:contract`, and `test:e2e` select exactly their named suites through the same entry point. Keep `lint`, `typecheck`, and `build` as separate gates. [Japa setup and suite selection](https://japa.dev/docs/installation).

Use Japa's assertion plugin and lifecycle hooks for isolated fixtures and cleanup. Start Express on an ephemeral port for HTTP tests and use the Japa API client against that real listener; use a fresh temporary SQLite **file** per independently running test or group, deterministic clocks, and seeded fixtures. Migration tests belong in `integration`; dependency request/response fixtures and OpenAPI examples belong in `contract`. Japa drives Compose `e2e` tests, with real service containers and disposable volumes; tests that need process death or a lost response must exercise a real child process/proxy. Do not depend on a developer's persistent database, shared parallel-test file, or a mock where the gate requires a real boundary. Name every Japa suite and command in the test report, including any skipped or blocked suite.

| Gate | Required evidence and pass condition |
| --- | --- |
| Static/build | Lint, strict TypeScript check, production build, lockfile consistency, no committed secrets, and clean generated OpenAPI validation. Zero failures. |
| Migration/seed | Fresh `up` migration and idempotent seed succeed; local/test `down` and second `up` succeed on disposable data; foreign keys, checks, unique/partial indexes, and actual schema version are verified. Production `down` is rejected. |
| Unit | Validation, money arithmetic/overflow, request fingerprinting, token hash/expiry/revocation, HMAC verification, transition matrix, retry classification/backoff, and error mapping have deterministic tests. |
| HTTP integration | Every route's success/error shape, auth/role/ownership, pagination, cart mutations, idempotency-key conflict, OpenAPI route, and health behavior are tested against Express with a temporary SQLite file. Assert that no client PUT/PATCH payment-status route exists. |
| Checkout concurrency | Two simultaneous checkouts of one cart and two replays of one key produce one pending provider reference and one reservation set. Different key while pending reuses the attempt; a new key after failure creates exactly one new attempt. |
| Stock/fulfilment | Concurrent carts cannot reserve more than available stock; failure/cancellation releases stock; success consumes it once, creates one fulfilment and item set, and marks the cart paid. Empty/zero/overflow/mixed-currency carts are rejected. |
| Provider initialisation | Timeout, `503`, response lost after provider creation, permanent rejection, process restart, and idempotent same-reference retry are covered. No path creates a second provider payment or holds a DB transaction across the HTTP call. |
| Webhook | Valid success/failure/cancellation, identical sequential and concurrent duplicates, same event ID with altered body, conflicting terminal events, wrong amount/currency/reference, invalid signature, malformed body, and database rollback are covered with exact HTTP outcomes. Crash-after-commit replay adds no second fulfilment or outbox intent. |
| Reconciliation/expiry | Missing webhook is recovered by provider status; provider outage leaves pending; day-30 provider-pending result fails and releases stock; concurrent webhook/expiry has one winner; late provider success creates one incident/admin alert and no fulfilment. |
| Outbox/SSE | Queue outage, lost queue acknowledgement, duplicate dispatcher tick, API restart, possible duplicate queue job/email, disconnected SSE, reconnect/read recovery, and user event isolation are tested. One API notification intent remains durable; payment success remains committed when either notification channel fails. |
| Contract | API OpenAPI examples validate against real responses. Provider initialisation/status/webhook fixtures and queue `POST /jobs` durable acceptance, correlation-key, and possible duplicate-submission fixtures agree with the dependency contracts. Any contract mismatch fails the gate. |
| Compose end-to-end | With real service containers, run login → cart → checkout → provider completion → webhook → paid cart/fulfilment/email/SSE; also run duplicate webhook, provider timeout, missing webhook reconciliation, invalid signature, and queue outage/recovery. Assert final database state and logs, not only HTTP responses. |

Test-gate completion means a failing assertion blocks deployment; skipped required suites are reported as incomplete. Coverage percentage alone does not substitute for the concurrency and crash/recovery cases.

## 9. Deployment gates and rollback

The API is deployed as one container built from a small **exact patch-pinned Alpine** Node base image. Record and review the image digest and dependency lockfile at implementation time; do not use a moving `latest` tag. Use a multi-stage build, production dependencies only in the runtime stage, non-root user, writable data mount, and a health check. The Compose deployment may orchestrate other services, but this document gates only the API image and its declared dependency contracts.

| Gate | Requirement before proceeding |
| --- | --- |
| D1: configuration | Trusted-network binding, non-default secrets, valid CORS origins/internal URLs, mounted persistent `api.db` path, and no secrets in image or repository. |
| D2: artifact | Reproducible Yarn install/build, exact base-image patch pin, successful image smoke start, and static/test gates above green. |
| D3: persistence | Back up the current SQLite database using a SQLite-safe backup method before migration; verify volume permissions and free space. Run API `up` migrations once before API startup. Never run `down` in deployment. |
| D4: readiness | Start API only after migrations; `/health/ready` confirms schema and database. Provider and queue endpoints/auth contracts are reachable for checkout/notification tests; their outage behavior is still exercised. |
| D5: functional smoke | Execute seeded login, product/cart read, checkout, provider-confirmed completion, payment read, one fulfilment, stock decrement, outbox acceptance, SSE, and OpenAPI fetch on the deployed Compose stack. |
| D6: recovery smoke | Replay a webhook and checkout key, interrupt provider and queue, verify no duplicate payment/fulfilment, then restore them and observe reconciliation/outbox drain. Confirm an invalid signature is rejected and logged without status change. |
| D7: operations | README states local start/stop, migrations, seed/reset on disposable data, environment variables, failure-scenario walkthrough, test commands, log/request-ID tracing, backup/restore, and the late-success manual-resolution limitation. Record gate results and any unrun check. |

If a gate fails before traffic, do not expose the API. If a new image fails after migration, stop the API, preserve the database and logs, and restore the previous image only when it is schema-compatible. Otherwise restore the pre-migration database backup into an isolated verified volume before switching images. Never use a production `down` migration as rollback. Because this is a trusted demo, a complete local reset is allowed only against an explicitly disposable data volume.

## 10. Dependency contracts to carry into other service documents

These are **requirements of the API**, not implementation instructions for the other services:

| Dependency | Contract needed by the API |
| --- | --- |
| Mock Payment Provider | Idempotent `POST /payments` by reference/details; authenticated `GET /payments/:reference` returning reference, amount, currency, status, and URL when available; active failure-scenario catalogue; HMAC-signed raw webhook body with stable `event_id`; retry `503`/network failures and stop on `2xx` or permanent `4xx`. |
| Message Queue Service | Authenticated `POST /jobs` durably accepts each call. `notification_key` is stable correlation metadata; retry after a lost acknowledgement may create another job/email. The response distinguishes durable acceptance from temporary failure. |
| Frontend Service | Send Bearer token and checkout `Idempotency-Key`, retain the key across HTTP retries, use a new key for a new attempt, connect to SSE with an Authorization-capable stream client, and refetch payment state after reconnect. |
| API Documentation Service | Fetch public `/v1/api_docs.json` from its allowed CORS origin; document HMAC webhook separately from Bearer user routes. |

Any provider or queue contract absent from its own document is a cross-service integration blocker, not a reason for the API to read that service's SQLite file or silently weaken the API invariants.
