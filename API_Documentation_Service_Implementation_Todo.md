# API Documentation Service Implementation Checklist

Source of truth: [API_Documentation_Service_Implementation.md](API_Documentation_Service_Implementation.md). Check a task only after its implementation or named gate has been verified. Leave failed, skipped, or blocked gates unchecked and record the result. This list covers the API Documentation Service and verifies its API/frontend contracts; it does not assign those services' implementations here.

## 1. Workspace, service boundary, and static assets

- [ ] Create one Yarn workspace for the typed documentation shell and static Swagger UI application.
- [ ] Pin an exact `swagger-ui-dist` version in the workspace lockfile and serve its bundled JS/CSS locally.
- [ ] Provide `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `build` scripts.
- [ ] Use one Dockerfile and one non-root static-serving container for the documentation service.
- [ ] Keep API endpoint behavior, OpenAPI content, authentication policy, CORS, and payment state owned by the API Service.
- [ ] Add no documentation-service database, migration, payment processor, webhook signer, API proxy, or server-side user session.
- [ ] Keep the Frontend Service responsible for the new-tab link to this service's browser-reachable docs origin.
- [ ] Do not ship a stale bundled OpenAPI document as a fallback.

## 2. Runtime configuration and live specification

- [ ] Validate `API_ORIGIN` at container startup as an absolute browser-reachable HTTP(S) origin; refuse invalid or missing configuration.
- [ ] Generate public `/config.json` containing only `API_ORIGIN`, with no Compose-only DNS name, token, secret, or personal data.
- [ ] Publish the docs UI on trusted host loopback and align the frontend's `DOCS_ORIGIN` with that browser URL.
- [ ] Fetch `/config.json` with `cache: 'no-store'` before mounting Swagger UI.
- [ ] Serve HTML and runtime config without stale caching; allow versioned JS/CSS assets to use immutable caching.
- [ ] On first page load, fetch `${API_ORIGIN}/v1/api_docs.json` directly in the browser with `cache: 'no-store'`.
- [ ] Add an explicit **Refresh specification** action that fetches the live API document again without using a stale fallback.
- [ ] Validate OpenAPI JSON parseability, supported 3.x structure, expected security scheme, and expected API paths before interactive rendering.
- [ ] Validate every applicable root-, path-, and operation-level effective `servers` URL as absolute with origin exactly equal to `API_ORIGIN`.
- [ ] Reject absent/relative servers, arbitrary external hosts, or external references that would make Swagger UI fetch another origin.
- [ ] Show a clear retryable error for API outage, bad JSON, CORS failure, or invalid spec; block Try it out until a valid live spec loads.
- [ ] Show a configuration error for a server-origin mismatch instead of silently rewriting request URLs.
- [ ] Pass the validated in-memory `spec` object to Swagger UI, rather than letting Swagger UI fetch a separate `url`.
- [ ] Keep the browser-to-API path direct; do not add a documentation-service API proxy.

## 3. Swagger UI configuration and execution controls

- [ ] Set `validatorUrl: null` to disable Swagger UI's external online validator.
- [ ] Set `queryConfigEnabled: false` to prevent URL query parameters from overriding docs configuration or spec URL.
- [ ] Set `persistAuthorization: false`; the custom docs shell owns the agreed local-storage token.
- [ ] Set `withCredentials: false`; use Bearer authorization rather than cross-origin cookies.
- [ ] Set `showMutatedRequest: false` and verify generated request snippets do not reveal the injected token.
- [ ] Enable Try it out only for ordinary documented API methods and show that mutations change persistent demo data.
- [ ] Render `POST /v1/login`, `POST /v1/logout`, `POST /v1/webhooks/payment`, and `GET /v1/events` with schemas, responses, and examples intact.
- [ ] Pin and test a Swagger UI plugin that disables Try it out controls for those four special operations while leaving them visible.
- [ ] Hide Swagger UI's manual Authorize controls so the seeded-user picker is the only request identity source.
- [ ] Add a request interceptor that rejects attempts to execute the four special routes even if the UI plugin is bypassed.
- [ ] Restrict the request interceptor to the configured `API_ORIGIN` and reject arbitrary hosts or redirects.
- [ ] Inject the currently selected Bearer token for protected ordinary operations only; add none to public spec, seeded-user, or login calls.
- [ ] Add a response interceptor that clears the selected identity after a protected-operation `401` but leaves it intact on network failure.
- [ ] Add plain-language notes: provider-only HMAC is required for the webhook and SSE needs an authenticated streaming client.
- [ ] Implement no webhook signing or SSE connection in this service.
- [ ] Re-test plugin and interceptor behavior whenever the pinned Swagger UI version changes.

## 4. Seeded-user picker and token lifecycle

- [ ] Show a visible selected-user name/role and **Select user** or **Switch user** action in the docs shell.
- [ ] Fetch `GET /v1/demo/users` fresh from the browser and show the API-returned active seeded users with `user`/`admin` roles.
- [ ] Select a user by calling `POST /v1/login` with its `user_id` and validating the returned token/profile.
- [ ] Store the selected user/profile and Bearer token in this documentation origin's local storage across reloads.
- [ ] Keep the documentation visible before selection but require a selected user for protected Try it out requests.
- [ ] On reload, validate stored token/profile shape and restore the selection without silently calling login again.
- [ ] On a protected API `401`, clear local credentials, stop token injection, and prompt the participant to choose a user again.
- [ ] Treat API/network outage as retryable and distinct from token rejection.
- [ ] On **Switch user**, best-effort call `POST /v1/logout` with the old token, then clear credentials and the checkout key even if logout fails.
- [ ] Refresh the seeded-user list after switching users.
- [ ] Keep displayed identity consistent with actual request authorization; do not permit a manual Swagger token override.
- [ ] Never read or share the Frontend Service's different-origin local storage.
- [ ] Keep passwordless seeded admin access confined to the trusted demo deployment.

## 5. Checkout-key helper and accessible flow

- [ ] Add a visible **Generate new key** and **Copy key** helper using `crypto.randomUUID()` or equivalent cryptographic randomness.
- [ ] Store the current key per selected docs user in local storage across reloads until deliberately replaced.
- [ ] Clear the current checkout key when the selected user changes.
- [ ] Require the user to paste the key into the OpenAPI-declared `Idempotency-Key` header; do not silently inject or rotate it.
- [ ] Explain same-key retry after a timeout or uncertain checkout result.
- [ ] Explain new-key creation for a new payment attempt after confirmed failure/cancellation.
- [ ] Let the API's returned payment URL lead to the provider browser checkout; do not implement provider completion or payment verification here.
- [ ] Add keyboard-accessible picker, refresh, copy/generate, and retry controls with visible focus and status/error announcements.
- [ ] Show readable roles, a narrow-screen layout, and clear error/retry states for config, spec, user-list, and login failures.
- [ ] Show a trusted-demo notice that Try it out can create carts and payments.

## 6. Browser security and privacy

- [ ] Bundle local scripts/styles and use a restrictive CSP with `connect-src` limited to the configured API origin.
- [ ] Load no third-party Swagger UI, font, validator, CDN, analytics, or arbitrary specification URL.
- [ ] Keep tokens and checkout keys out of URLs, logs, analytics, runtime config, error reports, and generated request snippets.
- [ ] Keep service/webhook credentials out of the browser bundle and never provide the webhook HMAC secret to Swagger UI.
- [ ] Verify the API allows this docs origin through CORS only for intended methods/headers; CORS does not replace Bearer/HMAC authorization.

## 7. Automated test gates — check only after passing

- [ ] **Static/build:** lint, strict typecheck, asset build, exact Swagger UI package/lockfile, no committed secrets, custom Alpine/Nginx image build, and non-root start pass.
- [ ] **Runtime config:** missing, malformed, non-HTTP(S), or Compose-only API origin fails startup; valid `/config.json` is public/no-store and contains no credential.
- [ ] **Frontend link:** configured `DOCS_ORIGIN` opens the host-local docs UI in a new browser tab.
- [ ] **Live spec:** browser fetches public `/v1/api_docs.json` fresh on load and refresh; API outage/recovery never serves a stale spec as current.
- [ ] **Spec failures:** bad JSON, unsupported/missing OpenAPI data, CORS denial, absent/relative/wrong-origin servers, and external references block Try it out with clear retry/config errors.
- [ ] **API contract:** live spec covers public/protected routes, HTTP Bearer, HMAC-only webhook, required checkout header, request/response examples, and browser API origin; examples match real responses.
- [ ] **Picker roles/login:** active user/admin seeds appear, one selection logs in, and protected Try it out uses that selected token.
- [ ] **Token persistence:** reload restores selected user/token from local storage without re-login; invalid stored shape or protected `401` clears it.
- [ ] **Switch/expiry:** switch attempts revocation and clears old token/key even on API outage; network errors do not masquerade as expiration.
- [ ] **Ordinary execution:** supported GET/POST/PATCH/DELETE operations execute according to the live spec, with mutations affecting only disposable test data.
- [ ] **Special-route controls:** login/logout/webhook/SSE remain visible but cannot execute through Swagger UI; bypassing the UI control is blocked by the request guard.
- [ ] **Picker-only identity:** manual Swagger Authorize is unavailable and cannot override the selected user.
- [ ] **Checkout helper:** random key generation/copy, persistence, uncertain same-key retry, new-key subsequent attempt, and switch-user clearing pass.
- [ ] **Checkout request:** Swagger checkout includes the pasted `Idempotency-Key`, yields a provider URL, and does not imply the docs service verifies payment.
- [ ] **Security:** no token in URL/snippets/logs, no external validator/CDN or arbitrary API origin, query config disabled, and restrictive CSP pass in a real browser.
- [ ] **Accessibility:** keyboard navigation, focus, screen-reader announcements, errors, and narrow viewport pass.
- [ ] **Compose end-to-end:** select seeded user, create/read cart, checkout with key, open provider URL, and read API-confirmed status from real services.
- [ ] Use isolated browser profiles and disposable API seed data; never mutate a developer's real demo database in automated tests.
- [ ] Record each test command/result and every unrun check; do not call a static build deployment acceptance.

## 8. Deployment gates — complete in order

- [ ] **D1 Configuration:** validate browser `API_ORIGIN`, host-local docs binding, frontend `DOCS_ORIGIN`, API CORS origin, and required `Authorization`, `Content-Type`, and `Idempotency-Key` headers/methods.
- [ ] **D1 Origin safety:** verify runtime config has no secrets and the live spec has no arbitrary or mismatched server URL.
- [ ] **D2 Asset build:** pin/review Swagger UI and Alpine versions/digests; reproduce Yarn install/build; copy only required static assets into the runtime image.
- [ ] **D2 Runtime image:** use a single multi-stage Dockerfile, exact `alpine:3.24.4` Nginx runtime, non-root user, unprivileged port, and write access only to config/Nginx temporary paths.
- [ ] **D2 Headers/tests:** verify CSP, no-store HTML/config, immutable versioned assets, valid generated config, and passing static/unit/integration gates.
- [ ] **D3 Container readiness:** start one docs container; verify internal `/health/live` and `/health/ready`, config file, static assets, and host-browser access.
- [ ] **D3 API connectivity:** verify live OpenAPI fetch and browser CORS; show API outage in the UI without treating static docs container as crashed.
- [ ] **D4 Functional smoke:** open docs from frontend, select user/admin, run protected GET/cart mutation, paste a generated key, complete provider handoff, and inspect API payment.
- [ ] **D5 Recovery smoke:** exercise API/spec outage and restoration, wrong server origin, expired token, and failed switch-user logout.
- [ ] **D5 Security smoke:** verify blocked special-route execution, query-string config override failure, and no external validator/CDN requests or token exposure.
- [ ] **D6 README:** document host-local URL, start/stop, browser API origin, picker/local-storage limitation, checkout-key workflow, Try it out effects/special-route limits, browser CORS, tests, logs, and rollback.
- [ ] Record every deployment gate result and unrun check before accepting the service.
- [ ] On failed rollout, restore the prior static image with matching runtime config; perform no database migration or API payment-data rollback from this service.

## 9. Cross-service contract verification

- [ ] Verify the API serves accurate public `GET /v1/api_docs.json` directly to the browser from the configured docs origin.
- [ ] Verify every applicable OpenAPI server URL is absolute and matches browser `API_ORIGIN`.
- [ ] Verify the API spec describes seeded discovery/login/logout, Bearer protection, provider HMAC webhook, required checkout `Idempotency-Key`, response/error shapes, and actual routes without a client status-update route.
- [ ] Verify the API CORS allowlist permits the docs origin and required methods/headers for direct browser requests.
- [ ] Verify the Frontend Service opens this service's configured `DOCS_ORIGIN` in a new tab.
