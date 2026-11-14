# Mock Payment Provider Service

The provider is a local simulation. It never collects card details or settles real funds. Server routes require a provider service token; checkout uses a random URL capability and does not use API user credentials.

## Local run

From the repository root, run `yarn install`, then use `yarn deploy:local` to generate the root `.env` and provider secret files before starting the demo stack. For provider-only development, provide the settings from the root `.env.example` and valid secret files through the provider's `*_SECRET_FILE` variables, then run `yarn workspace @executivepros/provider build`, `yarn workspace @executivepros/provider migrate:up`, `yarn workspace @executivepros/provider prestart`, and `yarn workspace @executivepros/provider start`. The migration and prestart scripts run compiled files from `dist/`. The provider listens on its configured port; the browser origin is `PROVIDER_PUBLIC_ORIGIN`, while its webhook target is the fixed internal `API_WEBHOOK_URL`.

Use the service-authenticated `POST /payments/initialise`, `GET /payments/:reference`, and `GET /failure-scenarios` routes. Opening the returned URL displays the provider simulation. Pay, Fail, or Cancel updates provider-owned state and creates an immutable webhook event before returning the completion page. A provider `2xx` webhook response means the API acknowledged the event; it does not change the provider outcome.

## Scenarios and operations

The seeded scenario catalogue is stable and read-only at runtime. `PROVIDER_001` delays persistence, while `PROVIDER_002` returns an initialization error before persistence. `WEBHOOK_004` skips delivery; `WEBHOOK_011`, `WEBHOOK_013`, and `WEBHOOK_016` transmit invalid evidence; `WEBHOOK_008` sends a conflicting event after a successful acknowledgment. Webhook attempt rows and Workmatic `done`/`dead` jobs are retained for inspection; there is no manual replay endpoint or dashboard.

Run `yarn workspace @executivepros/provider test`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `lint`, `typecheck`, and `build`. Japa integration and contract fixtures use fresh file-backed databases and ports from `.env.test`. Use the root deployment workflow for Compose, migrations, backup, and restore. Reset only an explicitly disposable provider volume; never run `migrate:down` in production or delete persistent provider data as rollback.
