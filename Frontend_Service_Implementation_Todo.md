# Frontend Service Implementation Checklist

Source of truth: [Frontend_Service_Implementation.md](Frontend_Service_Implementation.md). Check a task only when its implementation or stated gate is verified. Keep failed, skipped, or blocked gates unchecked and record the result. This list covers frontend work and the contracts it must verify with other services; it does not assign those services' implementation to the frontend.

## 1. Workspace, UI foundation, and runtime configuration

- [ ] Create a strict TypeScript React SPA in one Yarn workspace using Vite, React Router, Tailwind, and shadcn/ui.
- [ ] Add workspace scripts for `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `build`.
- [ ] Separate routing, session state, direct API request helpers, SSE stream, payment dialog, scenario controls, and page components.
- [ ] Use React state only for the response currently displayed; add no cross-route API-data cache, TanStack Query cache, or service-worker data cache.
- [ ] Generate public `/config.json` at container startup with browser-reachable `API_ORIGIN`, `PROVIDER_ORIGIN`, `DOCS_ORIGIN`, and `MAILPIT_ORIGIN`.
- [ ] Fetch runtime config with no-store behavior before mounting the app, validate all configured origins, and show a configuration error if invalid.
- [ ] Keep secrets out of runtime config, the built bundle, and static files.
- [ ] Serve runtime config and HTML without stale caching; allow normal immutable caching only for hashed static assets.
- [ ] Set every API-data GET to `cache: 'no-store'`; do not fall back to a stale stored response when a fresh request fails.
- [ ] Abort in-flight fetches on route departure or user switch and issue fresh requests on route entry and relevant changes.
- [ ] Do not add background payment polling; use route entry, actions, SSE, provider hints, reconnect, and manual refresh for new data.

## 2. Session, navigation, and shared shell

- [ ] Read and shape-check the selected seeded user and Bearer token from local storage on app start.
- [ ] Redirect `/` to `/login` without a stored session and to `/products` with one; clear a rejected token on the first protected request.
- [ ] Fetch `GET /v1/demo/users` fresh on `/login` and display active seeded users with `user`/`admin` role labels.
- [ ] Implement user selection through `POST /v1/login`, store the returned token/profile, and navigate to `/products`.
- [ ] Add Bearer authorization to protected API requests without putting tokens in URLs or logs.
- [ ] On API `401` or token expiry, clear local credentials/displayed data, stop SSE, and ask the user to select a user again; do not silently re-login.
- [ ] Distinguish a network outage from token rejection and provide a retry action without clearing a valid session.
- [ ] Add a global **Switch user** action; close iframe, abort requests, close SSE, clear displayed state and prior pending checkout key, and best-effort revoke the old token via `POST /v1/logout`.
- [ ] Clear old credentials even when logout fails; show the seeded-user selector for the new session.
- [ ] Show current user's name/role and navigation to products/payments in a responsive shared shell.
- [ ] Add global new-tab links to the configured API Documentation Service and Mailpit UI using `noopener`/`noreferrer`.
- [ ] Omit a separate logout button; use Switch user for this demo.
- [ ] Treat role-based UI presentation as convenience only; rely on API authorization for protected data and actions.

## 3. Products, carts, and payment pages

- [ ] Implement `/products` with fresh `GET /v1/products`, stable pagination, available stock, loading/empty/error states, and manual refresh.
- [ ] Fetch `GET /v1/cart` fresh on the products page and display the active cart and server-returned total.
- [ ] Add products with `POST /v1/cart`, set quantities with `PATCH /v1/cart/items/:product_id`, remove items with `DELETE /v1/cart/items/:product_id`, and abandon with `DELETE /v1/cart`.
- [ ] Validate positive quantities for UX while treating API validation/stock responses as authoritative.
- [ ] Refetch products and cart after mutations or stock/state conflicts; never send a client-computed charge amount.
- [ ] Format server-provided NGN minor-unit amounts for display without changing the amount submitted to checkout.
- [ ] Implement `/payments` with fresh paginated `GET /v1/payments`, status/reference/amount/date, and detail links.
- [ ] Show owner-scoped results for users and the API's system-wide results for admins, without treating UI filtering as authorization.
- [ ] Implement `/payments/:id` with fresh payment, cart/items, attempt history, fulfilment, and safe incident summary.
- [ ] Show loading, empty/not-found (`404`), pending, success, failed, cancelled, and API-error states on payment pages.
- [ ] Add manual payment refresh and a same-cart **Retry payment** action only for API-confirmed failed/cancelled retryable carts.
- [ ] Start a retry with the historical cart ID and a new idempotency key; return to `/products` for a ready iframe or `202` initialization state.
- [ ] Never expose a client payment-status update action or a retry action for a paid cart.

## 4. Checkout and idempotency

- [ ] Generate a cryptographically random `Idempotency-Key` when starting a checkout attempt.
- [ ] Store the current user/cart/scenario/key as a pending intent in local storage before sending checkout.
- [ ] Reuse the stored key after a timeout, abort, or uncertain HTTP result; generate a new key only for an API-confirmed new attempt after failure/cancellation.
- [ ] Guard ordinary checkout controls against repeated clicks, apart from the explicit double-checkout demo.
- [ ] Handle `201` new ready, `200` existing/replayed ready, and `202` unresolved provider initialization responses.
- [ ] For a compatible new request while a cart has a pending payment, show the existing attempt instead of offering another charge.
- [ ] For `202` without a URL, display payment ID/reference and **Initializing payment**, with fresh manual payment read and same-key checkout retry; do not poll or invent a second payment.
- [ ] Open the provider dialog only after a fresh ready response supplies a valid provider payment URL.
- [ ] Clear an obsolete pending intent on user switch and never apply one user's key to another user's checkout.
- [ ] Explain that an aborted client request may already have reached the server; do not label it a failed payment without API confirmation.

## 5. Provider iframe, message, and new-tab fallback

- [ ] Keep the user on `/products` and display the provider payment URL in a shadcn/ui dialog with a titled iframe.
- [ ] Validate the URL is HTTP(S) and its origin exactly matches runtime `PROVIDER_ORIGIN` before embedding or opening it.
- [ ] Set a restrictive iframe sandbox allowing only required forms, scripts, and provider same-origin behavior; do not grant top-level navigation or automatic popups.
- [ ] Set a restrictive iframe referrer policy and never send the app Bearer token into the iframe or payment URL.
- [ ] Provide an always-visible, validated **Open in new tab** fallback for a blocked or unusable iframe.
- [ ] Provide keyboard-accessible close, focus trapping/restoration, descriptive status, and responsive dialog sizing.
- [ ] Accept only `postMessage({ type: 'mock-payment.finished', reference })` from the configured provider origin and active iframe window with a matching payment reference.
- [ ] Ignore spoofed, malformed, stale, or mismatched provider messages and never trust a message's status claim.
- [ ] On a valid provider hint, close the dialog immediately and fetch the payment from the API with no-store behavior.
- [ ] If the API still reports pending, show a pending banner with manual refresh and a payment-detail link; do not claim completion.
- [ ] If the API confirms success/failure/cancellation, show that result and a payment-detail link.
- [ ] If the user closes the dialog early, retain a pending banner/detail link and do not cancel the payment.
- [ ] If SSE confirms terminal status before a provider message, close the dialog and show the API-confirmed outcome.
- [ ] When new-tab fallback is used, rely on SSE and manual refresh because the active iframe may not send a message.
- [ ] Require frontend `frame-src` for only the provider origin and verify provider `frame-ancestors` plus `X-Frame-Options` permit embedding.

## 6. SSE and fresh payment state

- [ ] Open `GET /v1/events` through an Authorization-capable fetch stream; never put the token in a query string.
- [ ] On each payment status event, fetch the affected payment again before updating displayed state.
- [ ] Reconnect with bounded backoff after interruption and show an **Updates disconnected** state while offline.
- [ ] Refetch the visible payment immediately on SSE reconnect.
- [ ] Add manual refresh for payment status without periodic polling.
- [ ] Abort the stream on user switch or token rejection and avoid displaying another user's events.
- [ ] Resolve disagreement between provider hint and SSE using fresh `GET /v1/payments/:id` as the authority.

## 7. Failure-scenario controls and explanations

- [ ] Fetch `GET /v1/failure-scenarios` fresh on `/products`; show active codes, names, and descriptions without hard-coded provider IDs.
- [ ] Pass a selected provider scenario as `failure_scenario_code` during checkout.
- [ ] Show catalogue-unavailable errors while allowing ordinary checkout with no scenario.
- [ ] Make provider and client demo scenarios mutually exclusive for each attempt.
- [ ] Show scenario controls to every seeded user, including admin and normal user roles.
- [ ] Implement a double-checkout control that sends two concurrent requests for one cart with distinct keys, displays both responses and the one resulting payment, and opens at most one iframe.
- [ ] Implement a client-timeout control that aborts a checkout after a short demo timeout, explains uncertainty, and retries with the same key.
- [ ] Implement an SSE-disconnect control that closes the stream, shows disconnection, reconnects, and fetches current state without polling.
- [ ] Explain outcomes from fresh API responses and safe incident summaries; do not fabricate payment completion or expose admin-only details.
- [ ] Cover API-process crash and webhook-integrity cases through provider scenarios/tests where available, without adding a browser crash button or status-update route.

## 8. Security, accessibility, and error handling

- [ ] Keep only demo profile, token, and current checkout intent in local storage; validate stored data before use.
- [ ] Apply restrictive CSP for scripts, API connections, and provider framing; rely on React escaping and avoid raw HTML injection.
- [ ] Validate every external URL before iframe or new-tab use; keep the provider on a separate origin.
- [ ] Handle API validation, `401`, `404`, `409`, `422`, `503`, network failure, and aborted request distinctly.
- [ ] Show clear loading/empty/error/retry states and prevent a failed fresh request from being presented as a current cached payment status.
- [ ] Use labelled controls, visible focus, keyboard navigation, dialog focus management, screen-reader status announcements, and success/error text independent of colour.
- [ ] Support desktop and narrow/mobile layouts, long product names, empty lists, and pending/failed payment states.
- [ ] Show payment status outside the iframe so inaccessible or blocked iframe content does not hide the result.
- [ ] Document the trusted-demo local-storage token limitation and the fact that frontend role display cannot enforce access.

## 9. Automated test gates — check only after passing

- [ ] **Static/build:** lint, strict typecheck, Vite production build, lockfile consistency, runtime-config validation, and no committed secrets pass.
- [ ] **Test tooling:** use Vitest, React Testing Library, and MSW for component/API-contract tests and Playwright for real-browser Compose flows.
- [ ] **Routing/session:** `/` redirect, seeded roles, login, local-storage reload, expired-token re-selection, network-error distinction, Switch user, revocation attempt, request/SSE cleanup, and route guards pass.
- [ ] **Fresh-data contract:** route entry, mutation, SSE event/reconnect, provider hint, and manual refresh issue fresh GETs; no client API-data cache, service-worker data cache, server-side API data cache, or background polling is used.
- [ ] **Products/cart:** pagination, empty/loading/error states, active-cart CRUD, server total display, stock conflict refetch, and role-neutral shopping pass.
- [ ] **Checkout:** `201`/`200`/`202`, persisted key, uncertain same-key replay, failed-payment new-key retry, ordinary duplicate-click guard, and paid-cart rejection pass.
- [ ] **Frame security:** invalid provider URL, iframe sandbox/CSP, blocked frame, new-tab fallback, and no token disclosure pass.
- [ ] **Message handling:** spoofed origin/source/reference, malformed/stale messages, valid hint plus fresh API read, and pending-after-hint close behavior pass.
- [ ] **SSE/status:** Bearer fetch stream, event refetch, disconnect/reconnect, manual refresh, owner isolation, token-expiry cleanup, and terminal API confirmation pass without polling.
- [ ] **Scenario demos:** fresh catalogue, ordinary checkout on catalogue failure, exclusive selection, double checkout, timeout replay, SSE disconnect, and clear explanations pass for normal/admin users.
- [ ] **Payment pages:** owner/admin scope, pagination, detail/attempts/fulfilment, safe incident summary, `404`, pending state, and retryable-cart flow pass.
- [ ] **Accessibility/responsive:** keyboard/screen-reader flow, dialog focus and announcements, contrast, narrow screens, and status outside iframe pass.
- [ ] **Contract:** frontend requests/responses match API routes; provider framing/message contract and browser origins work; queue email delivery is not described as exactly once.
- [ ] **Compose end-to-end:** login → products/cart → checkout → embedded provider → API-confirmed payment → payment detail passes in a real browser with API-state assertions.
- [ ] **Compose failure end-to-end:** failed/cancelled retry, provider scenarios, timeout replay, double checkout, SSE disconnect, admin payment view, and docs/Mailpit links pass.
- [ ] Record test commands/results and every skipped or blocked suite; do not treat a passing build alone as frontend acceptance.

## 10. Deployment gates — complete in order

- [ ] **D1 Runtime origins:** validate browser-reachable API, provider, documentation, and Mailpit origins from the host browser, not only the Compose network.
- [ ] **D1 Browser policies:** verify API CORS allows the frontend, frontend `connect-src`/`frame-src` allow only intended origins, and provider `frame-ancestors`/`X-Frame-Options` allow embedding.
- [ ] **D1 Configuration:** generate public runtime config at startup, reject invalid config, and keep secrets out of it and the image.
- [ ] **D2 Build:** reproduce Yarn install and Vite build; pin an exact Nginx Alpine patch and review the image digest.
- [ ] **D2 Runtime image:** use one non-root static container, a multi-stage Dockerfile, a health check, and only a writable runtime-config output location.
- [ ] **D2 Static serving:** configure SPA deep-link fallback; serve runtime config and HTML fresh while allowing immutable hashed assets.
- [ ] **D2 Verification:** pass static, unit, and integration gates before Compose/browser smoke tests.
- [ ] **D3 Readiness:** start one frontend container and verify health, root, `/products`, `/payments/:id`, runtime config, assets, and browser API connectivity.
- [ ] **D4 Functional smoke:** in a real browser verify seeded login, cart edit, checkout, iframe, validated provider hint, API-confirmed payment, payment list/detail, Switch user, docs link, and Mailpit link.
- [ ] **D5 Recovery smoke:** exercise `202` without URL, blocked iframe/new-tab fallback, timeout replay, SSE disconnect/reconnect, invalid `postMessage`, expired token, API outage, and stock conflict.
- [ ] **D5 Payment safety:** verify a same-key client retry is not presented as a second charge or new payment attempt.
- [ ] **D6 Operations:** document local start/stop, runtime origins, seeded login, cart/payment flow, scenario controls, iframe fallback, test commands, and local-storage/demo limitations in README.
- [ ] **D6 Evidence:** record every deployment-gate result and unrun check; do not expose the frontend as ready if a gate fails.
- [ ] Prepare rollback to the previous static image and its matching runtime config without mutating API payment data.
- [ ] Verify the new-tab fallback remains available if the provider framing policy fails during rollout.

## 11. Cross-service contract checks

- [ ] Confirm API seeded-user discovery/login/logout, products/cart CRUD, checkout key/scenario/cart contract, `201`/`200`/`202`, owner/admin payment reads, failure-scenario list, and Bearer SSE match frontend usage.
- [ ] Confirm API responses are fresh/no-store and no server-side data cache is introduced for products, carts, scenarios, or payments.
- [ ] Confirm provider payment URLs are browser-reachable at the configured origin and framing headers permit the frontend iframe.
- [ ] Confirm provider sends `postMessage({ type: 'mock-payment.finished', reference })` with the expected origin after the payment interaction.
- [ ] Confirm documentation and Mailpit origins are browser-reachable for global new-tab links.
- [ ] Align API Service documentation/tests with local-storage token persistence, ready `payment_url` on payment detail after `202`, and no-store API data responses before integration acceptance.
- [ ] Treat absent framing/message or stale API-data behavior as an integration blocker; do not bypass it with direct database access or client payment-status updates.
