import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('payments', (table) => {
    table.string('reconcile_claim_token').nullable()
    table.timestamp('reconcile_lease_until').nullable()
    table.integer('reconcile_attempts').notNullable().defaultTo(0)
  })
  await knex.raw("CREATE INDEX payments_reconcile_claims ON payments(status, reconcile_after, reconcile_lease_until) WHERE status = 'pending'")
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS payments_reconcile_claims')
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('reconcile_claim_token')
    table.dropColumn('reconcile_lease_until')
    table.dropColumn('reconcile_attempts')
  })
}
