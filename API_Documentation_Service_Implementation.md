# API Documentation Service Implementation Document

## 1. Purpose and boundary

This document specifies only the **API Documentation Service** in [System_Architecture.md](System_Architecture.md). It serves [Swagger UI](https://swagger.io/docs/open-source-tools/swagger-ui/) and a small trusted-demo shell to display the API Service's **live** OpenAPI JSON, select a seeded user, and execute ordinary API operations from the browser. The API Service owns the OpenAPI document, endpoint behavior, authentication, CORS policy, and payment state. The Frontend Service owns the global link that opens this documentation UI in a new tab.

The service is a single host-local, containerized static application. It has no database, migrations, payment logic, webhook secret, API proxy, or server-side user session. It must not cache a stale API specification as a fallback when the API is unavailable.

### Settled decisions

| Area | Decision |
| --- | --- |
| Specification | Fetch `GET <API_ORIGIN>/v1/api_docs.json` directly from the browser on page load and explicit refresh. The fetched API document is the sole specification source. |
| Interaction | Enable Swagger UI Try it out for ordinary API routes, including cart and checkout mutations, against the trusted demo database. Explain that these requests have effects. |
| Identity | A built-in seeded-user picker is the **only** way the docs tab authorizes Try it out. It includes active `user` and `admin` seeds. Store its selected user and Bearer token in this origin's local storage, as agreed for the demo. |
| Special routes | Show `POST /v1/login`, `POST /v1/logout`, `POST /v1/webhooks/payment`, and `GET /v1/events` in the documentation, but prevent their Swagger UI execution. The picker uses login/logout; the webhook needs provider HMAC; the SSE stream needs a long-lived stream client. |
| Checkout key | Provide a random key generator/copy helper. A user pastes the current key into Swagger's required `Idempotency-Key` header, reuses it after an uncertain response, and creates a new key for a new payment attempt. |
| Origin mismatch | If the OpenAPI effective server URL is absent, relative, or differs from configured browser `API_ORIGIN`, show a configuration error and block Try it out. Do not silently rewrite the API specification or request target. |

## 2. Static application, runtime configuration, and browser contracts

Create one Yarn workspace with an exact, lockfile-pinned `swagger-ui-dist` dependency, a small typed browser shell, static build assets, and focused tests. Use the upstream distribution's local JS/CSS assets; do not load Swagger UI or fonts from a CDN. `swagger-ui-dist` is intended for serving the built assets from a static server. [Swagger UI installation guide.](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/)

At container startup, validate `API_ORIGIN` as an absolute browser-reachable HTTP(S) origin, generate public `/config.json` with only that value, and refuse startup if it is invalid. In the agreed trusted local Compose deployment, publish the documentation UI on host loopback and set the frontend's `DOCS_ORIGIN` to that browser URL. Do not use Compose-only DNS names in `/config.json`. Fetch config with `cache: 'no-store'` before mounting Swagger UI. Serve `/config.json` and HTML without stale caching; versioned JS/CSS may use long-lived immutable caching. No credential, service token, webhook secret, or personal data belongs in config or the static bundle.

Fetch the OpenAPI JSON from `${API_ORIGIN}/v1/api_docs.json` with `cache: 'no-store'` on first load and when the user clicks **Refresh specification**. Validate parseability, supported OpenAPI 3.x structure, expected security scheme/paths, and every root-, path-, or operation-level effective `servers` value. The effective URL must be absolute and have exactly the configured `API_ORIGIN`; reject an absent/relative or arbitrary-host server entry before mounting interactive Swagger UI. If the API is down, returns invalid JSON, or fails CORS, show a clear retryable error and retain no stale spec as current. The docs service never fetches the API document server-side or proxies API requests.

Initialize Swagger UI with the validated in-memory `spec` object rather than its `url` option. Set `validatorUrl: null` to stop the default external validator, `queryConfigEnabled: false` to prevent URL-parameter overrides, `persistAuthorization: false` because the shell owns local token storage, `withCredentials: false`, and `showMutatedRequest: false` so generated request snippets do not display an injected Bearer token. Enable only the API methods actually documented for ordinary Try it out. A request interceptor must allow only the configured `API_ORIGIN`, deny the four special operations above, and inject the currently selected Bearer token for protected operations. It must not add a token to public spec, seeded-user, or login requests. A response interceptor clears stored identity on a protected-operation `401`; it does not turn network errors into logout. Swagger UI documents these options and its authorization APIs in its [configuration reference](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/).

Use a version-pinned Swagger UI plugin to set `allowTryItOut=false` for the four special operations while keeping their schemas, responses, and examples visible. Hide Swagger UI's manual Authorize controls so the picker is the only identity source. The request interceptor is a second enforcement layer if a UI upgrade changes a component. Pin the exact Swagger UI package version and test the plugin after every upgrade because [Swagger UI warns that plugin internals may change](https://swagger.io/docs/open-source-tools/swagger-ui/customization/plugin-api/). Add plain-language notes that webhook requests require provider-only HMAC and SSE needs an authenticated streaming client. The documentation service never signs webhooks or opens an SSE connection.

## 3. Seeded-user picker and checkout helper

The shell shows a visible selected-user name/role, **Select user** or **Switch user**, specification refresh, and checkout-key helper. Fetch `GET /v1/demo/users` fresh from the browser and list only the active seeded users and roles supplied by the API. Selecting one calls `POST /v1/login` with its `user_id`, validates the returned token/profile, and stores them in this documentation origin's local storage. Show the docs before selection, but require selection for protected Try it out operations. The API's passwordless admin seed is accepted only because the deployment is restricted to the trusted demo.

On reload, validate the stored token/profile shape and restore the selection without silently creating another token. On a protected API `401`, clear local credentials, stop injecting the old token, and prompt for selection; a network outage remains a retryable error. **Switch user** best-effort calls `POST /v1/logout` with the current token, clears local credentials and checkout key even if logout is unreachable, and then loads the fresh selector. Keep selected identity and actual request authorization consistent; manual Swagger authorization is disabled. Do not read or share the Frontend Service's local storage, which belongs to a different origin.

Use `crypto.randomUUID()` or equivalent cryptographic randomness for the checkout helper. Store the current key per selected docs user in local storage across reloads and show **Copy key** and **Generate new key** controls. Do not silently rotate or inject it: the user pastes it into the OpenAPI-declared required `Idempotency-Key` header of `POST /v1/cart/checkout`. Explain that a timeout/uncertain response requires **the same key**, whereas a new attempt after confirmed failure/cancellation needs a new key. Clear the helper on user switch. The payment URL returned by checkout is opened at the provider's browser origin; provider checkout and payment verification remain outside this service.

Provide keyboard-accessible controls, visible focus, status/error announcements, readable roles, responsive narrow-screen layout, and a retry action for config, spec, user-list, and login failures. Show a short trusted-demo notice that Try it out may create carts or payments. Never put tokens or checkout keys in the docs URL, analytics, logs, or error reports. Use a restrictive CSP permitting bundled scripts and required styles plus `connect-src` to the configured API origin only. No external validator, CDN, or arbitrary spec URL is allowed.

## 4. Test gates

All gates are mandatory before deployment. Use disposable API seed data and an isolated browser profile for integration and end-to-end tests; never mutate a developer's real demo database in automated tests. There is no documentation-service database or migration suite. Provide workspace scripts for `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `build`, and record each command/result and any unrun check. A passing static build alone is not acceptance.

| Gate | Pass condition |
| --- | --- |
| Static/build | Lint, strict typecheck, production asset build, exact Swagger UI dependency/lockfile, no committed secrets, custom Alpine/Nginx image build, and non-root image start pass. |
| Runtime configuration | Missing, malformed, non-HTTP(S), or Compose-only `API_ORIGIN` fails startup; valid public config is served no-store without credentials. Frontend `DOCS_ORIGIN` reaches the host-local UI. |
| Live specification | Browser fetches public `/v1/api_docs.json` fresh on load/refresh. API outage, bad JSON, unsupported/missing OpenAPI data, CORS failure, absent/relative/wrong-origin effective servers, and external references show a retryable or configuration error with no interactive stale fallback. |
| API contract | The live spec contains the API's public/protected routes, HTTP Bearer scheme, HMAC-only webhook description, required checkout `Idempotency-Key`, request/response examples, and browser-reachable server URL. Test examples against real API responses. |
| Picker/auth | User and admin roles appear; login selects one token; reload restores it from local storage; protected Try it out uses that token; protected `401` clears it; network failure does not. Switch user attempts revocation and clears old token/key even if the API is down. |
| Execution limits | Ordinary GET/POST/PATCH/DELETE operations can execute as allowed by the spec. Login/logout/webhook/SSE remain visible but have no working Try it out, including when the plugin guard is bypassed in a test. No manual Authorize path can override the picker. |
| Checkout helper | Cryptographic key generation/copy, persistence across reload, same-key uncertain retry guidance, new-key subsequent attempt, and clearing on user switch pass. Checkout request includes the pasted header. |
| Security/accessibility | No token in URL/snippets/logs, no external validator/CDN or arbitrary outgoing origin, query config disabled, restrictive CSP, keyboard/screen-reader status and controls, narrow viewport, and correct error announcements pass. |
| Compose end-to-end | From the docs UI, select a seeded user, create/read a cart, submit checkout with a key, open the returned provider URL, and read API-confirmed payment status. Verify the frontend's new-tab docs link and real browser CORS. |

## 5. Deployment gates, operations, and rollback

Build one multi-stage image: install the pinned Yarn dependencies and prepare the static shell/Swagger assets in a build stage, then copy only required files into a minimal Nginx image built on exact `alpine:3.24.4` with a reviewed digest. Run Nginx as non-root on an unprivileged container port, giving write access only to runtime config and Nginx-required temporary paths. Publish the UI on host loopback. Add internal `/health/live` and `/health/ready` checks for static serving and valid generated config. API availability is a browser-visible dependency state, not a reason to stop serving the documentation shell.

| Gate | Requirement before proceeding |
| --- | --- |
| D1: configuration | Validate browser `API_ORIGIN`, host-local docs binding, frontend `DOCS_ORIGIN`, API CORS allowlist for that origin and required methods/headers (`Authorization`, `Content-Type`, `Idempotency-Key`), no secrets in config, and no arbitrary spec server. |
| D2: artifact | Pin/review Swagger UI and Alpine versions/digests; reproduce Yarn build; verify local assets, non-root Nginx, CSP, no-store config/HTML, runtime-config generation, and passing static/unit/integration gates. |
| D3: readiness | Start one docs container; check internal liveness/readiness, static assets, config, host-browser access, live OpenAPI fetch, and API browser CORS. Distinguish an API outage from a docs-container failure. |
| D4: functional smoke | In a real browser, open from the frontend link, select a user/admin, run protected GET and cart mutation, paste a generated checkout key, complete the provider handoff, and inspect the API payment. |
| D5: recovery/security smoke | Exercise API/spec outage and restoration, wrong server origin, expired token, switch-user logout failure, blocked special-route execution, query-string config override, and absence of external validator/CDN calls. |
| D6: operations | README explains host-local URL, start/stop, runtime API origin, seeded picker and local-storage limitation, checkout-key workflow, Try it out mutation effects/special-route limits, browser CORS, test commands, logs, and rollback. Record gate results and every unrun check. |

If a gate fails, do not mark the docs UI accepted. Roll back by restoring the prior static image with its matching runtime config; there is no database or migration to roll back. Do not attempt to change API payment data from this service.

## 6. Cross-service contract to verify

Before integration acceptance, the API Service must serve an accurate, public `GET /v1/api_docs.json` with an absolute browser-reachable server URL matching `API_ORIGIN` at every applicable level. The spec must describe seeded-user discovery/login/logout, Bearer protection, the provider HMAC webhook without a client status-update route, the required checkout `Idempotency-Key`, response/error shapes, and the API's actual endpoints. The API must allow the configured docs origin through CORS for direct browser requests and required headers. These are dependencies to check, not API implementation work in this document. The Frontend Service provides a new-tab link to the configured `DOCS_ORIGIN`.
