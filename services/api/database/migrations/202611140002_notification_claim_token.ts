import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('notification_outbox', (table) => {
    table.string('claim_token').nullable()
  })
  await knex.raw('CREATE INDEX notification_outbox_claim ON notification_outbox(accepted_at, next_attempt_at, lease_until, id)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS notification_outbox_claim')
  await knex.schema.alterTable('notification_outbox', (table) => {
    table.dropColumn('claim_token')
  })
}
