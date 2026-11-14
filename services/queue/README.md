# Message Queue Service

The private queue accepts authenticated email jobs from the API, persists them in Workmatic's `jobs.db`, and delivers them to Mailpit over Compose-network SMTP. It exposes `POST /jobs`, `/health/live`, and `/health/ready` only. No queue port is published to the host.

## Local development

From the repository root, install dependencies with `yarn install`. Set `NODE_ENV`, `PORT`, `JOBS_DB_PATH`, `QUEUE_SERVICE_SECRET` (32 bytes minimum in tests; use `QUEUE_SERVICE_SECRET_FILE` outside tests), `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM`. The local SMTP host should be Mailpit; the service never sends to an external relay. Build the workspace, initialize the Workmatic database with `yarn workspace @executivepros/queue prestart`, then run `yarn workspace @executivepros/queue start`. The container deployment runs `node dist/src/initialize-db.js` as a removed prestart job before starting the regular queue container.

The root `.env.test.example` assigns high, distinct fixture ports. Copy it to ignored `.env.test` and set local values there; tests fail if required listener ports are missing. Run `test`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `typecheck`, and `build` from the queue workspace. Japa provisions a fresh file-backed database and HTTP fixture per integration test through `bin/test.ts`.

## Delivery behavior

`202 Accepted` confirms durable queue admission, not delivery. SMTP connection errors, timeouts, and 4xx responses receive at most three total attempts with 5-second and 10-second backoff. A 5xx rejection is logged and resolved as Workmatic `done`; this state does not mean Mailpit accepted the message. Mailpit acceptance can still be repeated after a crash or an ambiguous SMTP timeout. `notification_key` is correlation metadata and does not deduplicate jobs.

Logs correlate request ID, Workmatic job ID, notification-key hash, payment reference, attempt, outcome, and error class. Message bodies, recipients, and service secrets are excluded. Workmatic keeps completed and exhausted jobs in `jobs.db`; no automatic cleanup, dashboard, replay route, or dead-job alert is configured.

Back up `jobs.db` using the deployment's SQLite-safe backup flow. A database reset is allowed only for a disposable demo volume. Do not use production `down` migrations or remove persistent queue data as rollback.

## Operations

Run `yarn status` to inspect all six services, `yarn stop` to stop the stack while preserving volumes, and `yarn deploy:local` to resume it. Use the root `yarn backup` and `yarn restore` workflows for consistent SQLite backups; restore only into a new, explicitly disposable project. Inspect queue logs with the Compose project from `.env`:

```sh
docker compose --project-name executivepros_assessment --env-file .env --file compose.yaml logs --tail=100 queue
```

The queue has no dashboard or manual replay route. Readiness means the queue database and worker are available; an SMTP failure is logged and retried independently. Inspect Mailpit for capture rather than treating HTTP `202` or Workmatic `done` as proof of email delivery. The root README documents the host-local Mailpit URL, private SMTP endpoint, backup/restore, and disposable-volume reset.
