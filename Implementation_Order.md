# Implementation Order

This is the dependency order for implementing the six microservices in [System_Architecture.md](System_Architecture.md). Use each linked implementation document and checklist as the source of truth for that service's features, tests, and deployment gates. The [Deployment and Documentation implementation document](Deployment_and_Documentation_Implementation.md) owns the final Compose integration and submission gates. Work can be committed in smaller verified slices, but do not claim a service or the stack accepted while a required gate is deferred or failing.

## 0. Establish the shared contracts and repository foundation

Create the root Yarn workspace and six service directories, reserve the Compose service names and host/internal origins, and establish the project-scoped shared SQLite volume with service-owned subpaths. Add the root configuration template and secret-file convention, but leave full deployment acceptance until step 8. Confirm the local Compose installation supports `volume.subpath` before building database services.

Resolve these documented contract mismatches **before** implementing dependent calls, and update the affected service documents/checklists with the agreed contract:

- The provider exposes `POST /payments/initialise`, not the API plan's older `POST /payments` name. Its request carries immutable `checkout_expires_at`; HTTP `500` is a transient initialization result; `GET /payments/:reference` may return `404` until delayed initialization commits.
- The frontend's selected demo token persists in local storage; the API's `GET /v1/payments/:id` must return a ready `payment_url` after an earlier `202`, and API reads used for payment state must be served without stale caching.
- Queue `notification_key` is correlation metadata, not queue-side deduplication. An uncertain enqueue retry or SMTP replay can produce a second job/email while the API retains one durable notification intent.
- The API needs `API_PUBLIC_ORIGIN` so its OpenAPI `servers` value matches the browser origin. API, queue, and provider must support the root deployment's mounted `*_FILE` secrets. Keep browser origins distinct from internal Compose URLs.

**Exit gate:** the wire shapes, environment names, origin map, and service ownership rules agree across the plans and contract fixtures. No frontend or API checkout code should target an unresolved endpoint shape.

## 1. Build the API Service foundation

Implement the first two slices of [API Service](API_Service_Implementation.md): configuration and logging, `api.db` migrations/seeds, health, seeded-user discovery/login/logout, Bearer authorization, products, and active-cart CRUD. Establish its Japa v5 unit/integration/contract harness using disposable file-backed SQLite. Add the required public-origin configuration and browser CORS policy now, even if the final OpenAPI document arrives in step 5.

**Exit gate:** migrations and repeatable seeds, auth/ownership, product/cart behavior, health, error envelopes, and public/demo route boundaries pass against a temporary database. Checkout, webhooks, notifications, and the API's full Compose end-to-end gate remain open.

## 2. Build the Mock Email Service

Implement [Mock Email Service](Mock_Email_Service_Implementation.md) as the pinned-source Mailpit image with internal SMTP, loopback-only inbox UI, persistent `mailpit_data`, native health probes, and no relay/forwarding or automatic pruning. Use a direct SMTP test client to verify capture before the queue exists.

**Exit gate:** source/image, configuration, SMTP capture, HTTP health, persistence, and exposure checks pass. Queue-driven email and frontend-link checks wait for steps 3 and 7.

## 3. Build the Message Queue Service

Implement [Message Queue Service](Message_Queue_Service_Implementation.md): private authenticated `POST /jobs`, durable Workmatic `jobs.db`, worker startup/shutdown, Mailpit SMTP sending, retry classification, duplicate/replay behavior, logs, and health. Use the real Mailpit from step 2 and Japa v5 for unit, integration, and contract tests.

**Exit gate:** a job is acknowledged only after persistence, survives restart, reaches Mailpit, and follows the specified transient/permanent failure behavior. Confirm that two accepted requests with one `notification_key` may create two emails. API-generated notification and full API/queue/Mailpit end-to-end gates wait for step 5.

## 4. Build the Mock Payment Provider Service

Implement [Mock Payment Provider Service](Mock_Payment_Provider_Service_Implementation.md): its SQLite migrations/Workmatic tables, authenticated initialization and status lookup, browser checkout, scenario catalogue, immutable provider outcomes, signed webhook outbox/delivery, retries, and recovery. Use a contract fixture webhook receiver while the API's payment webhook is unfinished. Test browser framing and the exact-origin `postMessage` hint independently of the frontend.

**Exit gate:** initialization replay/conflict, delayed persistence, Pay/Fail/Cancel, status lookup, HMAC bytes, scenario matrix, outbox restart, and provider-owned Japa v5 gates pass against disposable data. Real API fulfilment and frontend iframe end-to-end gates wait for steps 5 and 7.

## 5. Complete the API Service payment path

Finish [API Service](API_Service_Implementation.md) against the real provider and queue: idempotent checkout and reservations; provider initialization/status recovery; signed webhook intake; atomic payment transitions, fulfilment, stock updates, and incidents; durable email outbox; SSE; periodic reconciliation; day-30 expiry; payment reads; and the live `GET /v1/api_docs.json`. Keep a failed day-30 payment terminal if the provider later reports success, with a discrepancy/admin alert as specified. Verify the direct-enqueue queue contract, including possible duplicate email after an uncertain acknowledgement.

**Exit gate:** API Japa v5 unit, integration, contract, and API-driven Compose end-to-end suites pass with the provider, queue, and Mailpit. Assert database, event, job, and log state for success, failure, cancellation, replay, invalid/missed webhook, provider timeout, and queue outage. The API's OpenAPI `servers` URL matches `API_PUBLIC_ORIGIN`. Browser UI acceptance remains for steps 6–7.

## 6. Build the API Documentation Service

Implement [API Documentation Service](API_Documentation_Service_Implementation.md) using the live API OpenAPI JSON from step 5: locally bundled Swagger UI, runtime browser origin, seeded-user picker, checkout-key helper, and guarded Try it out. Test direct browser CORS, wrong-origin spec rejection, and protected requests against the real API/provider flow.

**Exit gate:** documentation-service build, unit/integration, security/accessibility, and direct docs-to-API browser flow pass. The frontend's new-tab docs link is checked in step 7.

## 7. Build the Frontend Service

Implement [Frontend Service](Frontend_Service_Implementation.md) against all existing service contracts: seeded-user selection, products/cart, scenario choice, idempotent checkout, provider iframe and new-tab fallback, API-confirmed payment views, SSE, admin views, and docs/Mailpit links. Use its specified Vitest, React Testing Library, MSW, and Playwright gates, with a disposable Compose project for real-browser flows.

**Exit gate:** login through payment completion, failed/cancelled retry, timeout replay, provider hint validation, SSE recovery, role/ownership behavior, and both external UI links pass in a real browser. Re-run any service cross-contract gate previously deferred for the frontend.

## 8. Finish Deployment and Documentation

Complete [Deployment and Documentation](Deployment_and_Documentation_Implementation.md): six exact Alpine-pinned non-root images, one regular container per service, loopback publications, mounted secrets, shared-volume subpaths, root Commander one-shot migration flow, cold backup/isolated restore, Compose health and recovery, and the root README. Execute its T1–T8 and D1–D8 gates in order, re-running all service suites that depend on the now-complete stack. Prepare the repository URL, reviewed incremental Conventional Commit history, and separate full AI-work transcript for S1.

**Final acceptance:** all six service checklists and the root deployment checklist have their required gates verified and recorded. A build, isolated unit suite, or partial Compose smoke does not complete the assessment.
