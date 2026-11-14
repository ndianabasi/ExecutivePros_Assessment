# Mock Payment Provider Service

The provider is a local simulation. It never collects card details or settles real funds. Server routes require a provider service token; checkout uses a random URL capability and does not use API user credentials.

## Local run

From the repository root, run `yarn install`, then use `yarn deploy:local` to generate the root `.env` and provider secret files before starting the demo stack. For provider-only development, provide the settings from the root `.env.example` and valid secret files through the provider's `*_SECRET_FILE` variables, then run `yarn workspace @executivepros/provider build`, `yarn workspace @executivepros/provider migrate:up`, `yarn workspace @executivepros/provider prestart`, and `yarn workspace @executivepros/provider start`. The migration and prestart scripts run compiled files from `dist/`. The provider listens on its configured port; the browser origin is `PROVIDER_PUBLIC_ORIGIN`, while its webhook target is the fixed internal `API_WEBHOOK_URL`.

Use the service-authenticated `POST /payments/initialise`, `GET /payments/:reference`, `GET /failure-scenarios`, and `GET /diagnostics` routes. Diagnostics report pending payment/event counts, failed and skipped events, Workmatic dead jobs, oldest undelivered event, delivery-attempt count, and SQLite file/filesystem capacity. They never include payment capabilities, secrets, or webhook bodies. Opening the returned URL displays the provider simulation. Pay, Fail, or Cancel updates provider-owned state and creates an immutable webhook event before returning the completion page. A provider `2xx` webhook response means the API acknowledged the event; it does not change the provider outcome. Provider success may coexist with a failed, skipped, or rejected webhook; the API can reconcile status independently.

## Scenarios and operations

The seeded scenario catalogue is stable and read-only at runtime. `PROVIDER_001` delays persistence, while `PROVIDER_002` returns an initialization error before persistence. `WEBHOOK_004` skips delivery; `WEBHOOK_011`, `WEBHOOK_013`, and `WEBHOOK_016` transmit invalid evidence; `WEBHOOK_008` sends a conflicting event after a successful acknowledgment. Webhook attempt rows and Workmatic `done`/`dead` jobs are retained for inspection; there is no manual replay endpoint or dashboard.

Correlate provider logs by `request_id`, `provider_event_id`, and `attempt_number`; response evidence is bounded and redacted. Inspect authenticated `GET /diagnostics` for backlog and capacity, then use Mailpit and API payment detail to confirm downstream effects. Readiness reflects provider-owned storage and worker state; an API outage is a delivery condition, not proof that the provider payment failed.

Run `yarn workspace @executivepros/provider test`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `lint`, `typecheck`, and `build`. Japa integration and contract fixtures use fresh file-backed databases and ports from `.env.test`. Use the root deployment workflow for Compose, migrations, backup, and restore. Reset only an explicitly disposable provider volume; never run `migrate:down` in production or delete persistent provider data as rollback.
