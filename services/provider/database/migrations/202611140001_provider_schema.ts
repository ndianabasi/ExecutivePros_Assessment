import type { Knex } from 'knex'

/**
 * Creates provider payment, scenario, and webhook-delivery tables.
 *
 * @param knex - Knex migration connection.
 * @returns A promise that resolves after the provider schema is created.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('failure_scenarios', (table) => {
    table.string('code').primary()
    table.string('name').notNullable()
    table.text('description').notNullable()
    table.string('category').notNullable()
    table.text('config_json').notNullable()
    table.boolean('is_active').notNullable().defaultTo(true)
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
    table.check("category IN ('initialization', 'webhook')")
    table.check('is_active IN (0, 1)')
  })

  await knex.schema.createTable('payments', (table) => {
    table.increments('id').primary()
    table.string('reference').notNullable().unique()
    table.string('provider_reference').notNullable().unique()
    table.integer('amount').notNullable()
    table.string('currency').notNullable()
    table.enu('status', ['pending', 'success', 'failed', 'cancelled']).notNullable().defaultTo('pending')
    table.string('checkout_token_hash').notNullable().unique()
    table.string('payment_url').notNullable().unique()
    table.timestamp('checkout_expires_at').notNullable()
    table.string('scenario_code').nullable().references('failure_scenarios.code').onDelete('SET NULL')
    table.text('scenario_snapshot').nullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('completed_at').nullable()
    table.check('amount > 0')
    table.check("currency = 'NGN'")
  })
  await knex.raw('CREATE INDEX provider_payments_status_expiry ON payments(status, checkout_expires_at)')

  await knex.schema.createTable('webhook_events', (table) => {
    table.increments('id').primary()
    table.string('event_id').notNullable().unique()
    table.integer('payment_id').notNullable().references('payments.id').onDelete('CASCADE')
    table.string('event_type').notNullable()
    table
      .enu('status', ['pending', 'delivering', 'delivered', 'failed', 'skipped'])
      .notNullable()
      .defaultTo('pending')
    table.text('canonical_body').notNullable()
    table.text('transmitted_body').notNullable()
    table.string('transmitted_hash').notNullable()
    table.enu('signature_mode', ['valid', 'invalid']).notNullable().defaultTo('valid')
    table.timestamp('due_at').notNullable()
    table.timestamp('claim_until').nullable()
    table.string('claim_id').nullable()
    table.string('job_id').nullable()
    table.integer('delivery_rounds').notNullable().defaultTo(0)
    table.string('last_error_class').nullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('delivered_at').nullable()
    table.check("event_type IN ('payment.success', 'payment.failed', 'payment.cancelled')")
    table.check('delivery_rounds >= 0')
  })
  await knex.raw('CREATE INDEX webhook_events_due ON webhook_events(status, due_at, claim_until)')
  await knex.raw('CREATE INDEX webhook_events_payment_created ON webhook_events(payment_id, created_at)')

  await knex.schema.createTable('webhook_deliveries', (table) => {
    table.increments('id').primary()
    table.integer('webhook_event_id').notNullable().references('webhook_events.id').onDelete('CASCADE')
    table.integer('attempt_number').notNullable()
    table.string('request_body_hash').notNullable()
    table.integer('http_status').nullable()
    table.text('response_excerpt').nullable()
    table.integer('duration_ms').notNullable()
    table.string('error_class').nullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('completed_at').nullable()
    table.unique(['webhook_event_id', 'attempt_number'])
    table.check('attempt_number > 0 AND duration_ms >= 0')
  })
  await knex.raw(
    'CREATE INDEX webhook_deliveries_event_attempt ON webhook_deliveries(webhook_event_id, attempt_number)',
  )
}

/**
 * Drops the provider tables outside production environments.
 *
 * @param knex - Knex migration connection.
 * @returns A promise that resolves after the provider schema is removed.
 * @throws Error when a rollback is attempted in production.
 */
export async function down(knex: Knex): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Provider down migrations are disabled in production')
  }
  await knex.schema.dropTableIfExists('webhook_deliveries')
  await knex.schema.dropTableIfExists('webhook_events')
  await knex.schema.dropTableIfExists('payments')
  await knex.schema.dropTableIfExists('failure_scenarios')
}
