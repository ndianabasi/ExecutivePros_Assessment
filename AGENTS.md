# Repository Implementation Guidance

## Current objective

Implement the six-service assessment stack in `Implementation_Order.md`. Treat each service implementation document and its `_Todo.md` checklist as the contract. Keep `Deployment_and_Documentation_Implementation.md` as the source of truth for Compose, shared storage, secrets, backup, root README, and submission gates.

## Durable decisions

- Trusted host-local demo only. Bind browser ports to `127.0.0.1`; keep service calls on Compose DNS.
- Every published host port must be at least `10000`; current assignments are frontend `18080`, docs `18081`, provider `18082`, API `18083`, and Mailpit UI `18025`. Container ports and private SMTP/test ports remain service-specific.
- On this Docker Desktop setup, Compose `internal: true` prevented a loopback-published Mailpit UI from accepting host connections. Use the project-scoped bridge network and publish only explicit loopback host ports; keep SMTP unpublished.
- Six regular services: API, frontend, queue, docs, Mailpit, provider. One Dockerfile and one running container per service. One-shot setup/migration containers must be removed.
- One project-scoped SQLite volume uses distinct `api`, `queue`, and `provider` volume subpaths. Each non-root service sees only its own `/data`; Mailpit has a separate volume.
- No service reads another service's database. The root CLI orchestrates Docker and service-owned migrations only.
- API, queue, and provider automated tests use Japa v5. Frontend uses its planned Vitest/React Testing Library/MSW/Playwright stack. Keep databases and Compose volumes disposable in tests.
- Queue `notification_key` is correlation metadata, not idempotency. Enqueue and SMTP retries may duplicate email; payment fulfilment stays independent.
- No client payment-status update route. Provider-authenticated webhooks and reconciliation own status evidence.
- Preserve unimplemented tasks as unchecked. Check a task only after its stated behavior and gate pass.
- Commit small verified slices with Conventional Commit messages. Never commit secrets, generated runtime data, or test/demo volumes.

## Cross-service contracts to keep aligned

- Provider initialization is `POST /payments/initialise`, accepts immutable `checkout_expires_at`, and supports idempotent same-reference retries. Status lookup is `GET /payments/:reference`; delayed initialization can be temporarily absent.
- API checkout validates returned provider `payment_url` against explicit `PROVIDER_PUBLIC_ORIGIN`; internal provider calls use `PROVIDER_BASE_URL`.
- The API loads repository-root `.env` through `dotenv` before importing configuration; `.env` stays ignored, `.env.example` contains only nonsecret defaults and mounted secret-file paths, and shell/Compose variables take precedence.
- API checkout uses required `Idempotency-Key`; payment reads expose a ready provider URL after an earlier `202`; browser payment state is fetched without stale caching.
- Frontend and docs use browser origins; API/provider/queue use fixed internal Compose origins for service calls. OpenAPI `servers` equals `API_PUBLIC_ORIGIN`.
- The frontend, docs UI, and API use local-storage selection/token behavior as specified in their plans. API/queue/provider accept mounted `*_FILE` secrets.
- Mailpit accepts queue SMTP only on the Compose network; its UI is host-loopback only. Never configure a real SMTP relay.
- Mailpit `v1.33.1` is built from upstream commit `3bc38efc5c4687659b9099eb2c8d8f6e76113f11`. The local arm64 build used Alpine base digest `sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf` and produced image `sha256:e4b8f2c4d82c17e3ebdbaa8b59688ac420c94c67127745e079b5c441cf336901` (`10001:10001`). These are local build evidence, not a multi-platform release manifest.
- The existing default Compose Mailpit volume `executivepros_assessment_mailpit_data` contains prior inbox messages. The original container is stopped. Never reset or reuse this volume for tests; use a unique Compose project and remove only that project's disposable volume.

## Validation and workflow

- Read the relevant implementation plan and checklist before changing a service.
- Run the smallest meaningful suite for the changed slice, then required service and Compose gates when dependencies are ready. Record commands/results and unrun gates.
- Use `git diff --check` and inspect `git status` before committing; do not include unrelated or user-owned changes.
- Keep this file updated only with durable findings that will help later implementation stages.

## Japa integration test convention

- Every Node service workspace using Japa owns `bin/test.ts`; register the assert and API-client plugins there, declare named suites there, and run all scripts through that one entry point.
- In each Japa integration suite's `configure` hook, attach per-test setup with `suite.onTest(testCase => testCase.setup(...))`. That setup creates a fresh temporary file-backed database, runs the service migrations and idempotent seed, starts required HTTP fixtures on the distinct high loopback ports from `.env.test`, and returns one cleanup function that closes servers, destroys database connections, and removes the temp directory.
- Put shared setup and service helpers in test macros. Import the macro from tests to expose the fixture DB and common functionality through the Japa test context. Register the Japa API client centrally with the API test base URL; tests use route-relative paths. Keep `.env.test` ignored and provide `.env.test.example` with nonsecret high-port defaults distinct from development ports.
- Integration test bodies may insert rows needed for their scenario but must not provision/tear down databases or servers themselves. Unit tests remain isolated from this integration fixture. Use Japa per-test hooks for scenario-specific setup and cleanup.
- Read the current Japa docs for [installation](https://japa.dev/docs/installation), [test macros](https://japa.dev/docs/test-macros), [API client](https://japa.dev/docs/plugins/api-client), [assertions](https://japa.dev/docs/plugins/assert), and [lifecycle hooks](https://japa.dev/docs/lifecycle-hooks) when adapting this convention to a service.
