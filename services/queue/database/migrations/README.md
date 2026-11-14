# Queue database migrations

This version has no queue-owned tables. Workmatic owns and initializes its internal tables through `createDatabase()`; do not query or modify them through Knex. Add Knex migrations and CLI scripts only if the queue later introduces service-owned tables.
