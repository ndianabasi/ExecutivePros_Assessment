# Frontend Service Implementation Document

## 1. Purpose and boundary

This document specifies only the **Frontend Service** in [System_Architecture.md](System_Architecture.md). It is the React single-page application used to select a seeded user, manage a cart, start and inspect payments, demonstrate failure cases, and receive payment updates. The API Service, Mock Payment Provider, API Documentation Service, and Mock Email Service are dependencies; their internal implementation belongs in their own documents.

The target is a trusted assessment demo. Passwordless seeded-user selection and local-storage Bearer tokens are demo-only choices. The API remains authoritative for identity, authorization, prices, stock, payment state, and fulfilment. The frontend never sends a payment-status update or treats a provider iframe message as payment proof.

### Settled decisions

| Area | Frontend behavior |
| --- | --- |
| Framework | TypeScript React SPA, Vite, React Router, and shadcn/ui components. |
| Data access | Direct `fetch`; no client API-data cache, TanStack Query cache, service-worker data cache, or periodic payment polling. Fetch fresh data on route entry, relevant actions, SSE events/reconnect, provider messages, and manual refresh. |
| Session | Store the selected seeded user and Bearer token in local storage across reloads. When the API rejects an expired token, clear it and ask the user to select a user again; do not silently log in. A global **Switch user** action replaces a separate logout button. |
| Checkout handoff | Keep the user on `/products` and show the returned provider payment URL in an iframe inside an accessible inline dialog. Offer **Open in new tab** as a fallback. |
| Provider completion | Accept a validated `postMessage` hint from the active iframe, close the dialog immediately, then fetch the API payment. If it is still pending, show a pending banner and manual-refresh link. Only API state can confirm success, failure, or cancellation. |
| Failure demos | Show provider-backed scenarios and client-side double-checkout, timeout/retry, and SSE-disconnect controls to all seeded users. Exercise process-crash scenarios in tests rather than through a browser control. |
| Configuration | Read browser-reachable service origins from runtime config generated when the frontend container starts. API data and runtime config are fetched without HTTP caching; hashed static assets may use normal immutable caching. |

## 2. Workspace, application structure, and configuration

Create one Yarn workspace for a strict TypeScript Vite SPA. Use React Router for the five architecture routes, shadcn/ui and Tailwind for accessible components, and direct `fetch` for API calls. Keep routing, auth/session state, API request helpers, SSE stream handling, payment-dialog logic, scenario controls, and page components separate. React component state may hold the **currently displayed response**; do not add a cross-route server-state cache or retain stale API responses as a fallback after a failed fresh request.

At container startup, generate public `/config.json` containing the browser-reachable `API_ORIGIN`, `PROVIDER_ORIGIN`, `DOCS_ORIGIN`, and `MAILPIT_ORIGIN`. These are browser URLs, not Compose-only DNS names. Fetch and validate this file before mounting the app; serve it with `Cache-Control: no-store`. If configuration is missing or invalid, show a clear configuration error rather than making requests to a guessed origin. Do not put secrets in runtime config or the bundle. Hashed JS/CSS assets may be served with immutable caching; `index.html` and runtime config must be revalidated or served without caching so deployment changes take effect.

For every API data GET, use `fetch` with `cache: 'no-store'`, Bearer authorization when required, and an `AbortController` tied to page departure or user switch. Make a new request on page entry and after a relevant mutation or event; no request-response cache, background polling, or service worker should serve product, cart, scenario, or payment data. The API Service must also avoid server-side data caching and send suitable no-store response headers. This is a dependency contract, not a frontend implementation of API caching.

## 3. Session, routing, and shared UI

On application start, read the stored selected user/token, validate their shape, and use the token for protected requests. A missing token goes to `/login`. An API `401` clears stored credentials and in-memory user data, stops SSE, and returns to `/login` with a message to select a user again. Do not silently call the passwordless login endpoint when a token expires. A network failure is shown as a retryable error and must not be mistaken for an expired token.

`/login` fetches `GET /v1/demo/users` fresh and shows active seeded users with their `user` or `admin` role. Selecting one calls `POST /v1/login`, stores the returned token/profile, and navigates to `/products`. The global **Switch user** action closes any iframe, aborts requests, closes SSE, clears displayed data and the prior user's pending checkout key, best-effort calls `POST /v1/logout`, and then presents the user selector. Clear local credentials even if logout cannot reach the API. A standalone logout control is not required.

The shared shell shows the selected user's name/role, navigation to products and payments, Switch user, and buttons opening the API Documentation Service and Mailpit UI in new tabs with `noopener`/`noreferrer`. Only configured browser origins may be used for those links. Responsive layout, visible keyboard focus, readable status text, loading states, empty states, and retry actions are required. Role-specific presentation never substitutes for API authorization.

| Route | Required behavior |
| --- | --- |
| `/` | Redirect to `/login` without a stored session, otherwise `/products`. A rejected stored token is cleared on the first protected request. |
| `/login` | Seeded-user selector with roles, login progress/error handling, and redirect to `/products` on success. |
| `/products` | Fresh paginated products, available stock, active cart, add/set/remove/abandon controls, server-returned totals, checkout, provider scenario picker, client demo controls, and inline payment dialog. |
| `/payments` | Fresh paginated payment list. Users see their own payments; admins see the API's system-wide results. Show status, amount/currency, reference, creation time, and a detail link. |
| `/payments/:id` | Fresh payment/cart/items/attempts/fulfilment and safe incident summary, status-specific explanation, manual refresh, and same-cart retry after a failed or cancelled attempt. Respect API `404` for unavailable/other-user payments. |

The products page uses `GET /v1/products` with the API's page/page-size limits, `GET /v1/cart`, and the active-cart mutation routes. Validate positive quantities in the UI, but display API validation and stock conflicts as authoritative; re-fetch cart and products after mutations or a checkout conflict. The frontend never calculates a charge to send to checkout. It may display server-provided totals in NGN minor units formatted for users.

## 4. Checkout, provider iframe, and payment status

Generate a cryptographically random `Idempotency-Key` when the user starts a checkout attempt. Store the current user/cart/scenario/key as a pending checkout intent in local storage before sending the request. Reuse that key after an HTTP timeout or uncertain response; use a **new** key when starting a new attempt after the API confirms failure or cancellation. A compatible second request while the cart has a pending payment must show the existing attempt rather than offer another charge. On user switch, clear the pending intent so another user never inherits it.

While an API payment remains pending, keep the failure-scenario selector usable so the user can prepare a scenario for a future checkout. Do not replace the current attempt's saved key or scenario when selection changes; retrying the pending attempt must still reuse its original idempotency key and scenario. Provide a direct link to the Payments page so the user can inspect pending status. Checkout conflicts remain visible if a new attempt is submitted before the current cart becomes retryable.

`POST /v1/cart/checkout` may return `201` for a new ready attempt, `200` for an existing/replayed ready attempt, or `202` while provider initialisation is unresolved. For `201`/`200`, validate the returned `payment_url` against `PROVIDER_ORIGIN` and open the iframe dialog over `/products`. For `202` without a URL, show the payment ID/reference and an **Initializing payment** state with manual refresh of `GET /v1/payments/:id` and a retry of checkout using the same key; do not invent another payment or poll. If a later fresh read supplies the URL, enable the dialog. Invalid or non-HTTP(S) provider URLs are never embedded or opened.

The dialog contains an iframe with a descriptive title, focus management, keyboard-accessible close action, and a visible **Open in new tab** fallback using the same validated URL. Use a sandbox allowing only the provider's required forms/scripts/same-origin behavior; do not grant top-level navigation or automatic popups. Set a restrictive referrer policy. The frontend CSP allows framing only `PROVIDER_ORIGIN`, API connections only `API_ORIGIN`, and no unexpected script origins. The provider must send a `frame-ancestors` policy permitting the frontend origin and must not send a conflicting `X-Frame-Options` restriction. These are provider and deployment contract gates; [framing policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors) is distinct from API CORS.

Define the provider-to-parent hint as `postMessage({ type: 'mock-payment.finished', reference })`. Accept it only when `event.origin` equals `PROVIDER_ORIGIN`, `event.source` is the active iframe's `contentWindow`, the type/schema is valid, and the reference matches the active payment. Ignore status claims inside the message. On a valid hint, close the dialog, fetch `GET /v1/payments/:id` with `cache: 'no-store'`, and show the API's state. A pending result stays visibly pending with a manual refresh and link to payment detail. A terminal API result shows a success/failure/cancellation message and detail link. If the user closes the dialog before completion, do not cancel the payment; retain a pending banner and detail link. When the new-tab fallback is used, rely on SSE and manual refresh because the active iframe may not send a message.

Open `GET /v1/events` using an Authorization-capable fetch stream; do not put the token in the URL. On a status event, fetch the affected payment again before updating its displayed state. Reconnect with bounded backoff after interruption, show an **Updates disconnected** state, and refetch the visible payment on reconnect. Do not poll in the background. If an SSE event confirms terminal status while the iframe remains open, close the dialog and show the confirmed result. Abort the stream on user switch or token rejection. Treat the payment GET response as authoritative if an event and provider message disagree.

On `/payments/:id`, offer **Retry payment** only for a failed or cancelled attempt on a cart that is still retryable. Pass that cart ID to checkout with a new idempotency key; return to `/products` to show the new provider iframe if a URL is ready, or show the initializing state for `202`. Never retry a paid cart or expose a client payment-status update action.

## 5. Failure-scenario UI and response behavior

Fetch `GET /v1/failure-scenarios` fresh for the products page and show the provider's active code, name, and description. Pass a selected provider code as `failure_scenario_code` at checkout. If the catalogue is unavailable, show an error and allow ordinary checkout without a scenario. Do not hard-code provider scenario IDs. Provider scenarios and client demo controls are mutually exclusive for a single attempt to keep the observed result interpretable.

Provide three clearly labelled client-side demo controls to every seeded user:

1. **Double checkout:** send two concurrent checkout requests for the same cart with distinct idempotency keys; display both responses and the one resulting payment. Open at most one provider dialog.
2. **Client timeout and retry:** abort a checkout request after a short demo timeout, explain that the server may still have accepted it, and retry with the same key. Display the recovered payment rather than creating a new attempt.
3. **SSE disconnect:** intentionally close the stream, show a disconnected indicator, then reconnect and fetch the current payment. Do not claim that a missed SSE event changes payment processing.

The UI explains the observed outcome from fresh API responses and safe incident summaries. It must not disclose another user's incident details or pretend that a simulated invalid webhook completed a pending payment. API-process crash and webhook-integrity cases are covered by integration/end-to-end tests and provider scenarios where available, without adding an API crash button or a manual status-update route. Admin-only incident email behavior is an API/queue responsibility; the frontend may tell users that a case requires review without revealing admin details.

## 6. Security, accessibility, and error handling

Store only the demo user profile, Bearer token, and current checkout intent in local storage; never place tokens in URLs, provider iframe parameters, logs, runtime config, or error screens. Treat local storage as a trusted-demo compromise and use a restrictive CSP, React escaping, no raw HTML injection, and dependency checks. Validate external URLs before iframe/new-tab use. Keep the provider on a separate origin and accept `postMessage` only under the checks above.

Handle API validation errors, `401`, `404`, `409`, `422`, `503`, network failures, and aborted requests distinctly. A timeout/abort is an uncertain checkout outcome, not proof of failure. Keep loading and retry controls clear and prevent duplicate button clicks except in the explicit double-checkout demo. Never show a stale cached payment status as current after a failed fresh request.

Use accessible shadcn/ui controls with labelled form fields, status announcements, focus trapping/restoration for the dialog, keyboard close and fallback link, and readable success/error text independent of colour. Test desktop and narrow/mobile layouts, long product names, empty data, and pending/failed payment states. Do not make iframe content the only place where payment status is visible.

## 7. Test gates

All gates are mandatory before deployment. Provide workspace scripts for `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `build`. Use Vitest, React Testing Library, and MSW for deterministic component/API-contract tests; use Playwright for real-browser Compose flows. Record skipped suites as incomplete.

| Gate | Pass condition |
| --- | --- |
| Static/build | Lint, strict TypeScript check, production Vite build, lockfile consistency, runtime-config validation, and no committed secrets pass. |
| Routing/session | `/` redirect, seeded-user roles, login, reload from local storage, token expiry/`401` re-selection, network error distinction, user switch, token revocation attempt, state/SSE cleanup, and route guards pass. |
| Fresh-data contract | Route entry, mutation, SSE event, reconnect, provider hint, and manual refresh each issue a fresh API GET; no client API-data cache, service-worker data cache, server-side API data cache, or background payment polling is used. |
| Products/cart | Pagination, empty/loading/error states, add/set/remove/abandon, server total display, stock conflict refetch, and role-neutral shopping pass. |
| Checkout/idempotency | `201`/`200`/`202` handling, stored key on uncertain outcome, same-key timeout retry, new-key failed-payment retry, duplicate click guard, and paid-cart rejection pass. |
| Frame/message | Provider URL origin validation, iframe sandbox/CSP, accessible dialog, manual close, new-tab fallback, spoofed origin/source/reference rejection, valid hint followed by API refetch, and pending-after-hint behavior pass. |
| SSE/status | Authenticated fetch stream, owner-scoped display, event-triggered refetch, disconnect/reconnect, manual refresh, token-expiry cleanup, and terminal state confirmation pass without polling. |
| Scenario controls | Fresh provider catalogue, ordinary checkout if unavailable, exclusive scenario selection, concurrent double checkout, timeout replay, SSE disconnect, and clear outcome explanations pass for user and admin roles. |
| Payment pages | Owner/admin list scope, pagination, detail/attempts/fulfilment, safe incident summary, `404`, pending state, and retryable-cart navigation pass. |
| Accessibility/responsive | Keyboard and screen-reader flows, dialog focus, announcements, contrast, narrow screens, and no iframe-only status presentation pass. |
| Contract | Frontend requests/responses match the API implementation document, provider framing and `postMessage` contract, and browser-reachable runtime origins. The queue's at-least-once email limitation is not presented as exactly-once. |
| Compose end-to-end | Real browser flow covers login → products/cart → checkout → embedded provider → API-confirmed payment → payment detail, plus failed/cancelled retry, provider scenarios, timeout replay, double checkout, SSE disconnect, admin payments, and docs/Mailpit links. Assert API state as well as UI text. |

Test completion requires all mandatory suites and a recorded command/result list. A passing build alone is not frontend acceptance.

## 8. Deployment gates and rollback

Build the SPA in a multi-stage Dockerfile and serve it from one exact patch-pinned Nginx Alpine image. Run as non-root, with only the `/config.json` output location writable. Configure SPA route fallback so direct navigation to `/products` and `/payments/:id` serves `index.html`. Serve runtime config and HTML without stale caching; hashed static assets may be immutable.

| Gate | Requirement before proceeding |
| --- | --- |
| D1: configuration | Validate browser-reachable API/provider/docs/Mailpit origins, trusted-demo host binding, runtime config generation, API CORS origin, frontend `connect-src`/`frame-src`, and provider `frame-ancestors`/`X-Frame-Options` compatibility. |
| D2: artifact | Reproducible Yarn install/build, exact Alpine patch pin and reviewed image digest, non-root static serving, runtime-config validation, SPA fallback, and static/unit/integration gates pass. |
| D3: readiness | Start one frontend container; health check, root route, deep links, config file, static assets, and browser API connectivity work from the host, not only from the Compose network. |
| D4: functional smoke | Seeded login, cart edit, checkout, iframe load, validated provider message, API-confirmed payment, payment list/detail, user switch, docs link, and Mailpit link work in a real browser. |
| D5: recovery/security smoke | Exercise `202` without URL, provider frame block/new-tab fallback, checkout timeout replay, SSE disconnect/reconnect, invalid `postMessage`, expired token, API outage, and stock conflict. No duplicate charge is attributed to a client retry using the same key. |
| D6: operations | README explains local start/stop, runtime origins, seeded-user selection, cart/payment flow, scenario controls, iframe fallback, test commands, and trusted-demo/local-storage limitations. Record every gate result and any unrun check. |

If a gate fails, do not expose the frontend as ready. Roll back by restoring the previous static image and its matching runtime config; do not roll back or mutate payment data from this service. The frontend container has no database or migrations. If provider framing fails, the explicit new-tab fallback keeps payment possible while the framing contract is corrected.

## 9. Cross-service contracts to verify

These are dependencies of the Frontend Service, not instructions to implement the other services:

| Dependency | Contract needed by the frontend |
| --- | --- |
| API Service | Seeded-user discovery/login/logout; products and active-cart CRUD; checkout with required `Idempotency-Key`, optional scenario/cart ID, `201`/`200`/`202` outcomes; owner/admin payment reads; scenario catalogue; Bearer-authenticated SSE; fresh no-store API data. |
| Mock Payment Provider | Browser-reachable payment URL at configured origin; iframe-compatible framing headers; `postMessage({ type: 'mock-payment.finished', reference })` to the parent for a completed interaction; no top-level navigation requirement for the embedded flow. |
| API Documentation Service and Mailpit | Browser-reachable configured origins for new-tab links. Their UIs and internal behavior are outside this document. |

An absent provider framing/message contract or stale API-data response blocks the corresponding frontend gate. The frontend never reads another service's database, changes payment status directly, or assumes email delivery is exactly once.

Before integration acceptance, verify the API Service and tests match the agreed frontend contract: local-storage token persistence, `GET /v1/payments/:id` exposing a ready `payment_url` for recovery from `202`, and uncached API data responses. These are cross-service dependencies, not frontend implementation work.
