# Deployment and Documentation Implementation Document

## 1. Purpose and boundary

This document implements the **Deployment and Documentation** requirements in [System_Architecture.md](System_Architecture.md) for the complete six-service assessment stack. It owns the root Docker Compose topology, deployment orchestration, shared configuration and storage rules, root README, acceptance evidence, and assessment submission package. The six service implementation documents own application behavior, image contents, tests, and service-specific gates; this document verifies their handoffs rather than duplicating their internals.

The target is a **trusted, host-local demo**. Browser-facing ports bind to `127.0.0.1`; service-only ports stay on one Compose network. Passwordless seeded admin selection, interactive Swagger checkout, and unauthenticated local Mailpit are acceptable only within that boundary. Do not describe this stack as safe to publish on an untrusted interface.

| Settled area | Decision |
| --- | --- |
| Topology | Six regular Compose services: `api`, `frontend`, `queue`, `docs`, `mailpit`, and `provider`; one running container and one Dockerfile per microservice. Temporary setup/migration containers are removed after completion. |
| Images | Use a reviewed, exact patch-pinned Alpine base and recorded digest for every build/runtime stage. Build Mailpit from pinned upstream source and bundle Swagger UI assets locally; do not substitute non-Alpine prebuilt service images. |
| SQLite storage | One project-scoped named volume, `assessment_data`, contains `api/`, `queue/`, and `provider/` subdirectories. Each service mounts only its own volume subpath at `/data` and retains its documented DB filename. Mailpit uses a separate `mailpit_data` volume. |
| Migrations | The root Commander command runs service-owned initialization in sequential, removed, one-shot Compose containers **before** starting the six regular containers. Production `down` is forbidden. |
| Backup | Stop writers and take a cold, whole-volume snapshot before upgrading existing data. Restore into an isolated volume and verify it before switching over. |
| Submission | Keep the full AI-assistance transcript as a separate, reviewed assessment artifact. Verify incremental Conventional Commit history and provide the repository URL. |

## 2. Repository and Compose deliverables

Create a root Yarn workspace and a root Commander deployment CLI with documented commands for `deploy:local`, `db:up`, `db:down` (disposable local/test projects only), `backup`, `restore`, `status`, and `stop`. The root `compose.yaml`, `.env.example`, `.gitignore`, and README belong to the deployment layer. Each service has its own directory and **one** Dockerfile; Mailpit's directory is a source-build context, even though it needs no custom TypeScript application. The CLI invokes Docker commands and service-owned migration/init commands; it never opens another service's SQLite file itself. Preserve the repository's Conventional Commit history.

Use multi-stage builds and copy only runtime files into each final image. Pin image tags to complete patch versions and record resolved image digests in release evidence; a floating `latest` tag, unreviewed digest change, or non-Alpine prebuilt Mailpit/Swagger runtime image fails the artifact gate. Build native SQLite modules against the runtime Alpine/musl family. Run every regular container as non-root, with write access only to its mounted data or runtime-config/temporary paths. Keep source, build contexts, secret files, test fixtures, and database volumes out of final images unless required at runtime. The Mailpit and Swagger UI version choices remain those in their service documents until a reviewed upgrade.

Define one project-scoped Compose bridge network for container-to-container calls. Use explicit loopback host bindings and browser-reachable origins; never place Compose DNS names in frontend/docs browser config, provider payment URLs, or the API OpenAPI `servers` field. Every host-published port must be at least `10000`; container ports remain service-specific. The default local port map is:

| Compose service | Container endpoint | Host endpoint | Persistent data and health |
| --- | --- | --- | --- |
| `frontend` | HTTP container `8080`, host `FRONTEND_PORT` | `http://127.0.0.1:<FRONTEND_PORT>` | No database; its own static/config health check. |
| `api` | HTTP container `3000`, host `API_PORT` | `http://127.0.0.1:<API_PORT>` | `assessment_data` subpath `api` at `/data`, `API_DB_PATH=/data/api.db`; `/health/live` and `/health/ready`. |
| `provider` | HTTP container `3000`, host `PROVIDER_PORT` | `http://127.0.0.1:<PROVIDER_PORT>` | Subpath `provider` at `/data`, `PROVIDER_DB_PATH=/data/payment_provider.db`; `/health/live` and `/health/ready`. |
| `docs` | HTTP container `8080`, host `DOCS_PORT` | `http://127.0.0.1:<DOCS_PORT>` | No database; `/health/live` and `/health/ready`. |
| `mailpit` | UI/API `8025`, SMTP `1025` | UI/API `http://127.0.0.1:<MAILPIT_PORT>` only | `mailpit_data`; `/livez` and `/readyz`. SMTP is not host-published. |
| `queue` | HTTP `3000` | None | Subpath `queue` at `/data`, `JOBS_DB_PATH=/data/jobs.db`; `/health/live` and `/health/ready`. |

The root CLI must create `assessment_data` and its three subdirectories **before** Compose mounts `volume.subpath`; those paths must already exist. Use a removed, exact Alpine-pinned setup container mounting the volume root to create `api`, `queue`, and `provider` with distinct fixed service UIDs/GIDs (`10001`, `10002`, `10003`) and mode `0700`. The parent directory must not be writable by service users. The regular Compose mounts use long-form `volume.subpath` with `nocopy: true` to expose only the owned directory at `/data`; no service can read another database through its mount. The documented local baseline is Docker Compose `v5.2.0`; preflight must fail if the installed version cannot render and mount these subpaths. Verify with `docker compose config` and a real mount test. [Compose volume subpaths](https://docs.docker.com/reference/compose-file/services/#volumes) retain the service documents' `/data/<database>.db` paths while sharing one backup unit.

Keep top-level named volumes project-scoped so disposable end-to-end projects never mount the developer demo data. Do not set a fixed global volume `name:`. Use a unique Compose project name and separately allocated loopback ports for automated end-to-end runs; never run those suites against the normal demo project. `docker compose down` may stop/remove regular containers but must preserve named volumes by default; `down -v` is not a normal stop or rollback command.

## 3. Configuration, secrets, and cross-service routing

Ship `.env.example` with non-secret defaults, port/origin descriptions, and required variable names. `yarn deploy:local` creates the ignored `.env` from this template when it is absent, without overwriting an existing `.env`. After generating or validating the three independent cryptographically random 32-byte or stronger secret values in ignored `.local/secrets/` files (provider service authentication, provider webhook HMAC, and queue service authentication), set each corresponding `*_SECRET_FILE` entry in `.env` to its repository-relative `./.local/secrets/...` Compose source. Compose mounts those files read-only at `/run/secrets/...`; service container environment continues to use those container paths. Compose reads the updated `.env` for render, build, migrations, startup, and verification. Environment and secret initialization is idempotent, including concurrent local starts; existing settings and secret values are preserved except for the generated host secret paths. Resolve secret file creation with host-native path rules. POSIX hosts enforce directory/file modes `0700`/`0600`; Windows removes inherited ACLs and grants the current user access with `icacls`. Mount only each required file into the API, provider, or queue through Compose secrets. Each service reads its file before listening and rejects missing/weak secrets or conflicting direct and file values. Never commit, bake, print, or place secret values in `.env`, browser `/config.json`, URLs, logs, test reports, or `docker compose config` output. Existing secret files must not be silently rotated on restart; if persistent data exists but a required secret file is missing, fail preflight instead of generating a replacement.

`.env` is the sole source of published host port assignments: `FRONTEND_PORT`, `DOCS_PORT`, `PROVIDER_PORT`, `API_PORT`, and `MAILPIT_PORT`. Do not duplicate these as loopback origin variables. Compose derives each browser-facing origin as `http://127.0.0.1:<published-port>` for frontend, docs, API, provider, and Mailpit. The deployment manager validates each derived origin against the corresponding published port and uses those derived values for deployment probes. Internal service calls use fixed Compose DNS addresses and container ports.

The root configuration maps browser origins and internal addresses separately:

| Consumer | Required value |
| --- | --- |
| Frontend runtime config | Compose derives `API_ORIGIN`, `PROVIDER_ORIGIN`, `DOCS_ORIGIN`, and `MAILPIT_ORIGIN` from `API_PORT`, `PROVIDER_PORT`, `DOCS_PORT`, and `MAILPIT_PORT`. |
| Docs runtime config | Compose derives `API_ORIGIN` from `API_PORT`; the live OpenAPI effective server URL must match exactly. |
| API runtime config | Compose derives `API_PUBLIC_ORIGIN`, `FRONTEND_ORIGIN`, `DOCS_ORIGIN`, and `PROVIDER_PUBLIC_ORIGIN` from the corresponding host port variables. Internal calls use fixed `http://provider:3000` and `http://queue:3000`. |
| Provider runtime config | Compose derives `PROVIDER_PUBLIC_ORIGIN` and `FRONTEND_ORIGIN` from `PROVIDER_PORT` and `FRONTEND_PORT`; webhook target is fixed at `http://api:3000/v1/webhooks/payment`. |
| Queue and Mailpit | Queue uses `SMTP_HOST=mailpit`, `SMTP_PORT=1025`; Mailpit listens internally on `1025` and `8025` and allows only the expected local UI host. |

Check API CORS for the frontend and docs origins and `Authorization`, `Content-Type`, and `Idempotency-Key`; do not add browser CORS to Mailpit. Verify frontend `connect-src`/`frame-src`, provider `frame-ancestors`, and docs `connect-src` against these origins. The frontend's docs/Mailpit links open the configured browser URLs; the provider URL given to the browser uses its public origin; service-to-service authentication uses the fixed internal URLs. A wrong-origin OpenAPI document or provider URL blocks the browser flow rather than being silently rewritten.

## 4. Deployment workflow, backup, and rollback

The root Commander `deploy:local` operation follows these stages and exits non-zero at the first failed gate:

Print `starting:`, `success:`, or `failed:` for each preflight, build, volume, migration, startup, health, and browser-origin verification step. A failed operation must emit its `failed:` line and stop subsequent deployment steps. After all six services and browser-facing checks pass, print the loopback Frontend Service URL derived from `FRONTEND_PORT` so a nontechnical user can open the demo directly.

1. **Preflight:** verify Docker/Compose and Yarn/Node prerequisites, selected Compose project, host-port availability, disk space, exact image pins/digests, ignored secret files, required origins, and rendered `docker compose config`. Do not echo secrets. Require an explicit disposable project name for reset/down operations.
2. **Build and storage setup:** build the six service images, verify non-root runtime and native SQLite module load, create the shared named volume and protected subdirectories, and confirm each service sees only its own `/data` subpath. Prepare the separate Mailpit volume.
3. **Cold backup on upgrade:** if persistent data already exists, stop the six regular containers so all three SQLite writers and Mailpit are quiescent. Back up the whole shared volume including DB, `-wal`, and `-shm` files; back up the separate Mailpit volume when inbox history is to be preserved. Record project name, source volume IDs, image digests, timestamp, and checksums in a manifest stored outside the volumes. Verify archive readability before migration.
4. **Prestart database work:** use `docker compose run --rm --no-deps` with the API image for API `migrate:up` and idempotent seed, the provider image for `migrate:up`, idempotent scenario seed, and Workmatic initialization, then the queue image for Workmatic initialization and any queue-owned `up` migrations. Each command uses its service's subpath/secret mounts and must complete successfully before the next. There are no frontend/docs/Mailpit Knex migrations. Never invoke `down` in deployment. [Compose one-off commands](https://docs.docker.com/reference/cli/docker/compose/run/) do not publish service ports by default and are removed with `--rm`.
5. **Start and verify:** start exactly six regular containers, wait for their own health checks, then check browser host access, API CORS/OpenAPI origin, provider framing, docs live spec, queue-to-Mailpit SMTP, and API-to-provider/queue authenticated calls. Do not make API readiness depend on an outage of the provider/queue, queue readiness on SMTP, or provider readiness on the API webhook target; log those degradations and gate the end-to-end smoke separately.
6. **Acceptance smoke:** use disposable seeded data to run success, failure, cancellation, one failure scenario, checkout replay, provider webhook/reconciliation, payment read, SSE, and Mailpit capture. Record final database/job/event state and correlated logs, not only HTTP status. Do not mark deployment accepted until the named gates below pass.

Provide `status` and `stop` commands that preserve data. Restrict `db:down` and complete volume reset to an explicitly disposable local/test project and require the exact project/volume names before deleting anything. For a failed rollout, preserve logs and database files; restore a previous image only if it is schema-compatible. Otherwise restore the verified cold backup into **new isolated volumes**, validate SQLite integrity and service startup there, then switch the Compose project to that restored set. Never use production `down` migrations or persistent-volume deletion as rollback. A failed backup or migration blocks further startup until the previous stack or verified restore can be used.

## 5. README and assessment submission

Write the root README as the participant's entry point. It must include: system architecture and the six service responsibilities; a diagram/link to the architecture; prerequisites and exact local quickstart; generated secret-file policy; port/origin table; startup, health, logs, stop, backup/restore, and explicitly disposable reset commands; migration order and no-production-down rule; and how to run every service's test suites and the root Compose smoke. State which checks were actually run and which remain unrun.

Provide a step-by-step demo: choose a seeded user or admin, inspect products, edit a cart, choose a provider failure scenario, send checkout with an `Idempotency-Key`, complete Pay/Fail/Cancel at the provider, return to the frontend, confirm status through the API, inspect SSE and Mailpit, and open Swagger UI. Explain uncertain-response same-key retry, a new key after confirmed failure/cancellation, webhook loss/reconciliation, possible duplicate email, and late success after day-30 expiry requiring manual review. Link the API's live OpenAPI document and explain that the assessment's PUT/PATCH client payment-status endpoint was deliberately excluded in favor of provider-authenticated status updates.

For submission, provide the repository URL, a reviewed incremental **Conventional Commit** history, and a separate full AI-assistance transcript artifact with chronological prompts and responses rather than a prompt list. The README names the artifact and states how it accompanies the submission; the transcript is not committed to the source repository. Review both source and transcript for secret values/personal data before sharing; record any necessary redactions without omitting substantive implementation discussion. This submission gate is separate from the local deployment gates.

## 6. Root test and deployment gates

Run service-specific suites from the six implementation documents and record commands/results. In particular, API, queue, and provider use Japa v5; frontend uses its specified Vitest/React Testing Library/MSW and Playwright checks; docs uses its static/browser checks; Mailpit uses real image/SMTP/HTTP checks. The root tests use a unique disposable Compose project and volumes and do not overwrite the normal demo. Skipped required suites are incomplete, not passing.

| Test gate | Pass condition |
| --- | --- |
| T1: Compose/config | `docker compose config` resolves six regular services, correct build contexts/Dockerfiles, exact Alpine pins, project-scoped volumes/subpaths, private network, loopback publications, internal-only queue/SMTP, valid secret mounts, and no leaked secret values. |
| T2: Artifact/permissions | All six images build and start non-root; Mailpit source build and local Swagger assets are verified; native SQLite modules load; only intended runtime paths are writable; cross-service DB directory access fails. |
| T3: Prestart/migration | On fresh and existing disposable volumes, root `db:up` runs API/provider/queue steps in order, is repeatable, and blocks service startup on failure; production `db:down` is rejected. |
| T4: Origin/health | Browser and internal URLs resolve in their intended contexts; all six own health checks pass; API CORS, docs live spec URL, provider iframe policy, frontend links, and queue SMTP path match configuration. A recoverable dependency outage is logged without falsely marking an independent service dead. |
| T5: End-to-end | In a disposable stack, seeded login, cart, checkout, provider completion, webhook/reconciliation, fulfilment, SSE, Mailpit email, docs Try it out, and user/admin read permissions yield the expected final state. |
| T6: Failures | Duplicate/uncertain checkout, provider timeout, lost/invalid webhook, queue/Mailpit outage and recovery, duplicate email possibility, and restart of API/queue/provider preserve the documented payment and job invariants. |
| T7: Data safety | Cold backup captures all three SQLite files and WAL sidecars; an isolated restore passes integrity/readiness checks; normal stop/start preserves both volumes; disposable test project cannot see the demo project's data. |
| T8: Documentation | A reviewer can follow the README from a clean checkout to a working demo, repeat the scenario walkthrough, locate API/test/runbook information, and identify known limitations and recorded gate results. |

| Deployment gate | Required evidence before acceptance |
| --- | --- |
| D1: configuration | Trusted local binding, browser/internal origin map, secret files, Compose topology, writable volume ownership, and sufficient free space are valid. |
| D2: artifacts/tests | Reviewed exact Alpine patches/digests, reproducible builds, six non-root images, and all applicable service static/unit/integration/contract gates pass; name every unrun gate. |
| D3: backup | Existing data has a readable cold shared-volume backup and, when preserving inbox history, a Mailpit backup with manifest/checksums. |
| D4: migrations | API, provider, and queue one-shot prestart commands complete before regular containers start; no production `down` runs. |
| D5: readiness/contracts | Six containers pass health; browser origins, API CORS, OpenAPI server URL, provider framing, service authentication, and SMTP connectivity pass. |
| D6: functional smoke | Complete one payment through provider confirmation and API fulfilment; verify frontend status, SSE, docs, and Mailpit without assuming a queue acknowledgement means email delivery. |
| D7: recovery smoke | Exercise replay and dependency outage/restoration with disposable data; verify no duplicate payment/fulfilment, retained notification intent, and documented possible duplicate email. |
| D8: operations | README/runbook, logs, backup/restore, stop/reset safety, and all gate command/result records are complete. |
| S1: submission | Repository URL, incremental Conventional Commit history, reviewed source, and separate full AI transcript artifact are ready for the assessment. |

If any required test or deployment gate fails, do not mark the stack accepted. Do not count a successful build, `git diff --check`, or a partial service smoke as complete system acceptance.
