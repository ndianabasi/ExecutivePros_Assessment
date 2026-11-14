import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payment_reconciliation_attempts', (table) => {
    table.increments('id').primary()
    table.integer('payment_id').notNullable().references('payments.id')
    table.integer('attempt_number').notNullable()
    table.string('outcome').notNullable().defaultTo('in_progress')
    table.string('provider_status').nullable()
    table.text('redacted_details').nullable()
    table.timestamp('started_at').notNullable()
    table.timestamp('completed_at').nullable()
    table.unique(['payment_id', 'attempt_number'])
    table.check('attempt_number > 0')
  })
  await knex.raw('CREATE INDEX payment_reconciliation_attempts_timeline ON payment_reconciliation_attempts(payment_id, started_at DESC, id DESC)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_reconciliation_attempts')
}
