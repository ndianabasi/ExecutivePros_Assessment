# Repository Implementation Guidance

## Current objective

Implement the six-service assessment stack in `Implementation_Order.md`. Treat each service implementation document and its `_Todo.md` checklist as the contract. Keep `Deployment_and_Documentation_Implementation.md` as the source of truth for Compose, shared storage, secrets, backup, root README, and submission gates.

## Durable decisions

- Trusted host-local demo only. Bind browser ports to `127.0.0.1`; keep service calls on Compose DNS.
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
- API checkout uses required `Idempotency-Key`; payment reads expose a ready provider URL after an earlier `202`; browser payment state is fetched without stale caching.
- Frontend and docs use browser origins; API/provider/queue use fixed internal Compose origins for service calls. OpenAPI `servers` equals `API_PUBLIC_ORIGIN`.
- The frontend, docs UI, and API use local-storage selection/token behavior as specified in their plans. API/queue/provider accept mounted `*_FILE` secrets.
- Mailpit accepts queue SMTP only on the Compose network; its UI is host-loopback only. Never configure a real SMTP relay.

## Validation and workflow

- Read the relevant implementation plan and checklist before changing a service.
- Run the smallest meaningful suite for the changed slice, then required service and Compose gates when dependencies are ready. Record commands/results and unrun gates.
- Use `git diff --check` and inspect `git status` before committing; do not include unrelated or user-owned changes.
- Keep this file updated only with durable findings that will help later implementation stages.
