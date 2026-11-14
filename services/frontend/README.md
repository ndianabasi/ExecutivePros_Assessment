# Frontend Service

This is the trusted local assessment storefront. It uses a passwordless seeded-user selector, stores the selected Bearer token in this browser origin's local storage, reads API data directly without caching it, and treats API payment reads as authoritative. Never expose the demo to untrusted users.

## Local development

From the repository root:

```sh
yarn workspace @executivepros/frontend dev
```

The Vite server uses browser origins on ports `18083` (API), `18082` (provider), `18081` (API docs), and `18025` (Mailpit) unless overridden in the environment. The generated `public/config.json` is development-only, ignored by Git, and removed before a production build. Do not put credentials in those origins or this file.

## Compose

Compose publishes the frontend at `http://127.0.0.1:18080`; runtime config provides browser-reachable origins for API, provider, docs, and Mailpit. Start and inspect the service from the repository root:

```sh
docker compose up -d frontend
docker compose stop frontend
docker compose logs --tail=100 frontend
```

The seeded-user token and pending checkout intent stay in local storage on the frontend origin. Switching users attempts API revocation, then clears the token and intent even when logout is unavailable. Checkout mutations are persistent demo data. Checkout keys are stored before requests and reused after uncertain outcomes. A provider message is only a hint; the frontend displays success, failure, or cancellation after a fresh API read. The new-tab checkout fallback is available if the iframe cannot load.

The frontend makes no payment database changes and has no migration. Rollback restores the prior static image and matching runtime origins; it does not alter API payment data.

## Gates

```sh
yarn workspace @executivepros/frontend lint
yarn workspace @executivepros/frontend typecheck
yarn workspace @executivepros/frontend test:unit
yarn workspace @executivepros/frontend test:integration
yarn workspace @executivepros/frontend build
FRONTEND_TEST_URL=http://127.0.0.1:18080 yarn workspace @executivepros/frontend test:e2e
```

Unit and integration tests use Vitest, Testing Library, and MSW. Playwright is a real-browser test and must target a disposable Compose project/database; it creates a cart and payment. Do not point it at a developer's persistent demo database. Include test logs and leave every unrun gate open in `Frontend_Service_Implementation_Todo.md`.
