# API Documentation Service

This service is a static Swagger UI shell for the trusted local assessment demo. It fetches the API's live OpenAPI JSON and makes browser requests directly to `API_ORIGIN`; it has no database, proxy, payment state, or API credentials.

## Local runtime

Compose publishes the UI at `http://127.0.0.1:18081` and sets browser-visible `API_ORIGIN` to `http://127.0.0.1:18083`. The API must allow that docs origin through CORS. Do not set `API_ORIGIN` to a Compose-only DNS name such as `api`.

The seeded-user picker is passwordless and stores the selected demo Bearer token in this browser origin's local storage. Use only in the trusted assessment environment. Swagger requests can mutate demo carts and create payments. Paste the generated checkout key into the required `Idempotency-Key` field; reuse it after an uncertain checkout result and generate a new key for a new attempt after confirmed failure or cancellation.

Login, logout, provider webhook, and SSE operations remain documented but are blocked from Swagger Try it out. Switching identity attempts API logout, then clears local token and checkout-key state regardless of API availability.

## Commands

From the repository root:

```sh
yarn workspace @executivepros/api-docs lint
yarn workspace @executivepros/api-docs typecheck
yarn workspace @executivepros/api-docs test:unit
yarn workspace @executivepros/api-docs test:integration
yarn workspace @executivepros/api-docs test:e2e
yarn workspace @executivepros/api-docs build
```

`test:e2e` runs isolated Chromium browser contexts against a running docs container at `DOCS_TEST_URL` (default `http://127.0.0.1:18081`) and uses controlled API fixtures. For an alternate disposable Compose project, set `API_ORIGIN_TEST` and `PROVIDER_ORIGIN_TEST` to that project's browser origins as well. Full provider/API/queue checkout acceptance remains tracked in `API_Documentation_Service_Implementation_Todo.md` and the deployment checklist.

Start, stop, and inspect the service from the repository root:

```sh
docker compose up -d api-docs
docker compose stop api-docs
docker compose logs --tail=100 api-docs
```

The docs server logs contain static request and startup diagnostics only; bearer tokens and checkout keys must never be logged. Verify startup with `docker compose ps api-docs` and open `http://127.0.0.1:18081` in a browser.

## Runtime and rollback

The static image serves Nginx on container port `8080` as UID/GID `10004`; only Nginx/runtime temporary files and generated `/config.json` are writable. API outages leave the docs shell available and are reported in the browser. Rollback restores the prior docs image with its matching `API_ORIGIN`; there is no service database or migration.
