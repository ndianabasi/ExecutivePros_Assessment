# Deployment and Documentation Implementation Checklist

Source of truth: [Deployment_and_Documentation_Implementation.md](Deployment_and_Documentation_Implementation.md). Check a task only after its implementation or named gate has been verified. Keep skipped, failed, or blocked gates unchecked and record their results. This list covers root deployment, documentation, and submission work; the six service checklists still own their internal tasks.

## 1. Repository and build deliverables

- [ ] Create the root Yarn workspace and place the six microservices in distinct service directories, each with one Dockerfile.
- [ ] Create the root Commander CLI and scripts for `deploy:local`, `db:up`, disposable-only `db:down`, `backup`, `restore`, `status`, and `stop`.
- [ ] Add root `compose.yaml`, `.env.example`, `.gitignore`, and README without committing generated secrets, volumes, or build artifacts.
- [ ] Make the CLI invoke Docker and service-owned database commands without opening a service database from the host CLI.
- [ ] Keep exactly six regular Compose services and one running container for each: `api`, `frontend`, `queue`, `docs`, `mailpit`, and `provider`.
- [ ] Use only removed temporary setup and migration containers; add no seventh long-running service.
- [ ] Pin complete Alpine patch versions and review/record resolved image digests for every build and runtime stage.
- [ ] Use a single multi-stage Dockerfile per service, copy only runtime files, and avoid floating `latest` tags or non-Alpine prebuilt Mailpit/Swagger runtime images.
- [ ] Build Mailpit from the service document's pinned source release and bundle Swagger UI assets locally from its pinned package.
- [ ] Build SQLite native dependencies against the runtime Alpine/musl family and verify module load in final images.
- [ ] Run all regular containers as non-root and restrict writable paths to owned data, runtime config, and required temporary directories.
- [ ] Keep secrets, source/build inputs, disposable test fixtures, and database data out of final images unless required at runtime.
- [ ] Keep service implementation/testing ownership in their own documents and maintain incremental Conventional Commit history.

## 2. Compose topology, ports, and storage

- [ ] Define one private Compose network for internal service calls and use service names only in server-to-server URLs.
- [ ] Require every host-published port to be at least `10000`; keep container/internal ports at their service-defined values.
- [ ] Publish frontend HTTP only at `127.0.0.1:18080` mapped to container port `8080`.
- [ ] Publish API HTTP only at `127.0.0.1:18083` mapped to container port `3000`.
- [ ] Publish provider HTTP only at `127.0.0.1:18082` mapped to container port `3000`.
- [ ] Publish docs HTTP only at `127.0.0.1:18081` mapped to container port `8080`.
- [ ] Publish Mailpit UI/API only at `127.0.0.1:18025` mapped to container port `8025`; keep SMTP `1025` internal.
- [ ] Keep queue HTTP port `3000` internal with no host publication.
- [ ] Create project-scoped named volumes `assessment_data` and `mailpit_data`; do not give either a fixed global name.
- [ ] Create shared-volume subdirectories `api`, `queue`, and `provider` before mounting a Compose `volume.subpath`.
- [ ] Assign fixed distinct service UIDs/GIDs `10001`, `10002`, and `10003` to the API, queue, and provider data directories.
- [ ] Set each owned data directory to mode `0700` and prevent service users from writing the shared-volume parent.
- [ ] Use a removed, exact Alpine-pinned setup container with the volume root mounted to prepare ownership and permissions.
- [ ] Document Docker Compose `v5.2.0` as the local baseline and fail preflight if the installed Compose cannot render/mount `volume.subpath`.
- [ ] Mount only subpath `api` at API `/data`, `queue` at queue `/data`, and `provider` at provider `/data`, using long-form volume mounts and `nocopy: true`.
- [ ] Set `API_DB_PATH=/data/api.db`, `JOBS_DB_PATH=/data/jobs.db`, and `PROVIDER_DB_PATH=/data/payment_provider.db`.
- [ ] Prove each service cannot read another service's database directory through its regular mount.
- [ ] Mount the separate Mailpit volume at its documented data path; keep all database volumes persistent across normal stop/start.
- [ ] Use a unique Compose project and separately allocated loopback ports for automated end-to-end tests, never the normal demo volumes.
- [ ] Exclude `down -v` from normal stop/rollback commands; allow volume reset only for an explicitly disposable project.

## 3. Configuration, secrets, and browser contracts

- [ ] Document non-secret port/origin defaults and required variable names in `.env.example`.
- [ ] On initial local setup, generate three independent cryptographically random 32-byte-or-stronger service/HMAC secrets once under ignored `.local/secrets/` files.
- [ ] Make secret files owner-readable, mount each only into its API/provider/queue consumers, and expose its path via a corresponding `*_FILE` setting.
- [ ] Reject missing/weak secrets or conflicting direct/file secret settings before service listeners start.
- [ ] Preserve existing secret files on restart; never silently rotate them.
- [ ] Fail preflight when persistent data exists but a required secret file is missing; do not generate a replacement secret over existing data.
- [ ] Keep secret values out of Git, images, public runtime config, URLs, logs, test reports, and `docker compose config` output.
- [ ] Set frontend browser config to API `http://127.0.0.1:18083`, provider `http://127.0.0.1:18082`, docs `http://127.0.0.1:18081`, and Mailpit `http://127.0.0.1:18025`.
- [ ] Set docs browser `API_ORIGIN` to `http://127.0.0.1:18083` and verify the live OpenAPI effective server URL matches it exactly.
- [ ] Add/pass `API_PUBLIC_ORIGIN=http://127.0.0.1:18083` as the API's OpenAPI server URL configuration contract.
- [ ] Set API `FRONTEND_ORIGIN` and `DOCS_ORIGIN` to the published browser origins; use internal `http://provider:3000` and `http://queue:3000` for outbound service calls.
- [ ] Set provider public origin and frontend origin to browser URLs; set its fixed webhook target to `http://api:3000/v1/webhooks/payment`.
- [ ] Set queue SMTP target to `mailpit:1025`; configure Mailpit's local UI host allowlist without adding browser API CORS.
- [ ] Verify API CORS allows only the frontend/docs origins and required `Authorization`, `Content-Type`, and `Idempotency-Key` methods/headers.
- [ ] Verify frontend `connect-src`/`frame-src`, provider `frame-ancestors`, docs `connect-src`, and browser link targets match the configured origins.
- [ ] Reject or visibly block a wrong-origin OpenAPI server or provider payment URL instead of silently rewriting it.
- [ ] Keep passwordless seeded admin access, interactive Swagger mutations, and unauthenticated Mailpit confined to the trusted host-local demo.

## 4. Root deployment workflow and data safety

- [ ] Validate Docker/Compose and Yarn/Node prerequisites, selected Compose project, host port availability, disk space, image pins/digests, secrets, and origins before deployment.
- [ ] Render and validate `docker compose config` without printing secret values.
- [ ] Build all six images before running migrations or exposing the new stack.
- [ ] Create/verify the shared volume subpaths and Mailpit volume before starting service-owned migration jobs.
- [ ] On upgrade with existing data, stop all six regular containers before copying shared SQLite data; keep writers stopped through the cold backup.
- [ ] Back up the complete shared volume, including each database and its `-wal`/`-shm` sidecars.
- [ ] Back up the separate Mailpit volume when inbox history is to be preserved.
- [ ] Record project name, source volume IDs, image digests, timestamp, and archive checksums in a manifest outside the volumes.
- [ ] Verify backup archive readability before starting migration work.
- [ ] Invoke API `migrate:up` and idempotent seed in a removed `docker compose run --rm --no-deps` container.
- [ ] Invoke provider `migrate:up`, idempotent scenario seed, and Workmatic initialization in a removed one-shot container after API prestart succeeds.
- [ ] Invoke queue Workmatic initialization and any queue-owned `up` migrations in a removed one-shot container after provider prestart succeeds.
- [ ] Prevent regular service startup when any one-shot command fails; run no frontend/docs/Mailpit Knex migration.
- [ ] Disallow `down` migrations in deployment; permit root `db:down` only for an explicitly disposable local/test project.
- [ ] Start exactly six regular containers only after successful prestart work and wait for their service-owned health checks.
- [ ] Check host-browser access, CORS/OpenAPI server origin, provider framing, docs spec, queue-to-Mailpit SMTP, and authenticated API-to-provider/queue calls.
- [ ] Keep API, provider, and queue readiness tied to their own state rather than a recoverable outage of another service; log dependency degradation separately.
- [ ] Run a disposable acceptance smoke for success, failure, cancellation, a scenario, replay, webhook/reconciliation, payment read, SSE, Mailpit, and correlated final state/logs.
- [ ] Implement `status` and `stop` so they preserve persistent volumes.
- [ ] Restrict full reset to explicitly named disposable project/volume targets; never remove a persistent volume as normal rollback.
- [ ] On failure, preserve database files and logs; use a previous image only when schema-compatible.
- [ ] Otherwise restore the cold backup into new isolated volumes, verify SQLite integrity and startup there, then switch to the restored set.
- [ ] Stop deployment at the first failed gate and record the failure rather than claiming acceptance.

## 5. Root README and assessment package

- [ ] Summarize the architecture, all six service responsibilities, and a link to the architecture diagram/document.
- [ ] Document prerequisites and an exact clean-checkout local quickstart.
- [ ] Document generated secret-file policy without publishing secret values.
- [ ] Document the full browser/internal port and origin map and explain why Compose hostnames are not browser URLs.
- [ ] Document start, health/status, logs, stop, migration order, no-production-down, backup/restore, and disposable reset commands.
- [ ] Document every service's test scripts and the root disposable Compose smoke, with actual command/results and unrun gates.
- [ ] Walk through seeded user/admin selection, products, cart editing, failure scenario selection, checkout with `Idempotency-Key`, and provider Pay/Fail/Cancel.
- [ ] Explain returning to the frontend, confirming API payment status, observing SSE, inspecting Mailpit, and opening Swagger UI.
- [ ] Explain same-key retry after an uncertain response and a new key after confirmed failure/cancellation.
- [ ] Explain webhook loss/reconciliation, possible duplicate email, and manual review of late provider success after day-30 API expiry.
- [ ] Link the API's live OpenAPI document and explain the intentional absence of client PUT/PATCH payment-status updates.
- [ ] State trusted-demo security limits and the local-only exposure requirement.
- [ ] Provide the repository URL in the submission instructions and verify incremental Conventional Commit history.
- [ ] Prepare a separate chronological, full AI-assistance transcript artifact containing prompts **and** responses, not a prompt list.
- [ ] Name the separate transcript artifact in the README and explain how it accompanies the assessment; do not commit it to the source repository.
- [ ] Review source and transcript for secrets/personal data, record necessary redactions, and retain substantive implementation discussion.

## 6. Root automated test gates — check only after passing

- [ ] Run and record the six service documents' applicable test suites: Japa v5 for API/queue/provider, frontend Vitest/React Testing Library/MSW and Playwright, docs static/browser checks, and real Mailpit image/SMTP/HTTP checks.
- [ ] Use a unique disposable Compose project, separate volumes, and separately allocated loopback ports for root tests; never mutate the developer demo project.
- [ ] **T1 Compose/config:** verify six regular services, correct Dockerfiles/build contexts, Alpine pins, project-scoped volume subpaths, private network, loopback publications, internal-only queue/SMTP, and secret-safe rendered config.
- [ ] **T2 Artifact/permissions:** verify six non-root images, Mailpit source build, local Swagger assets, native SQLite module load, restricted writable paths, and failed cross-service DB access.
- [ ] **T3 Prestart/migration:** verify fresh/existing volume `db:up` order and repeatability, startup blocking on failure, and production `db:down` rejection.
- [ ] **T4 Origin/health:** verify browser/internal routing, six own health checks, API CORS, docs live spec URL, provider iframe policy, frontend links, queue SMTP path, and appropriate dependency degradation.
- [ ] **T5 End-to-end:** verify seeded login, cart, checkout, provider completion, webhook/reconciliation, fulfilment, SSE, Mailpit email, docs Try it out, and owner/admin reads against final state.
- [ ] **T6 Failures:** verify uncertain/duplicate checkout, provider timeout, lost/invalid webhook, queue/Mailpit outage and recovery, possible duplicate email, and API/queue/provider restart invariants.
- [ ] **T7 Data safety:** verify cold backup includes all three SQLite databases and WAL sidecars, isolated restore integrity/readiness, normal stop/start persistence, and test/demo volume separation.
- [ ] **T8 Documentation:** have a reviewer use the README from clean checkout through scenario walkthrough, tests, API information, limitations, and gate evidence.
- [ ] Record every root/service test command, result, and skipped/blocked suite; do not treat a build or partial smoke as system acceptance.

## 7. Deployment and submission gates — complete in order

- [ ] **D1 Configuration:** validate local bindings, origin map, secret files, Compose topology, volume ownership, and free space.
- [ ] **D2 Artifacts/tests:** record reviewed Alpine patch pins/digests and reproducible non-root builds; pass every applicable service static/unit/integration/contract gate.
- [ ] **D3 Backup:** produce and verify a cold shared-volume backup and, when needed, a Mailpit backup with manifest/checksums.
- [ ] **D4 Migrations:** complete API, provider, and queue one-shot prestart commands before regular startup; run no production `down`.
- [ ] **D5 Readiness/contracts:** verify all six health checks, browser origins, CORS, OpenAPI URL, framing, service auth, and SMTP path.
- [ ] **D6 Functional smoke:** finish one payment with provider/API confirmation and verify frontend status, SSE, docs, and Mailpit without equating queue acceptance to delivery.
- [ ] **D7 Recovery smoke:** exercise replay and dependency outage/restoration on disposable data; prove one payment/fulfilment and retained notification intent while accepting duplicate-email possibility.
- [ ] **D8 Operations:** finish README/runbook, logs, backup/restore, stop/reset safeguards, and command/result evidence for all gates.
- [ ] **S1 Submission:** provide repository URL, reviewed incremental Conventional Commit history, reviewed source, and separate full AI transcript artifact.
- [ ] Keep failed, skipped, or blocked gates unchecked; do not call the deployment or submission accepted until every applicable gate passes.
