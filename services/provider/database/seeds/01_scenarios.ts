import type { Knex } from 'knex'

const scenarios = [
  [
    'PROVIDER_001',
    'Delayed initialization',
    'Wait before persisting the payment so status lookup may temporarily return 404.',
    'initialization',
    { delay_ms: 30000 },
  ],
  [
    'PROVIDER_002',
    'Initialization server error',
    'Return HTTP 500 before creating a provider payment.',
    'initialization',
    { status: 500 },
  ],
  [
    'WEBHOOK_001',
    'Concurrent duplicate webhook',
    'Submit two concurrent copies of one event.',
    'webhook',
    { copies: 2, concurrent: true },
  ],
  [
    'WEBHOOK_002',
    'Sequential duplicate webhook',
    'Submit three copies one second apart.',
    'webhook',
    { copies: 3, interval_ms: 1000 },
  ],
  [
    'WEBHOOK_003',
    'Delayed webhook',
    'Schedule the webhook fifteen seconds after completion.',
    'webhook',
    { delay_ms: 15000 },
  ],
  [
    'WEBHOOK_004',
    'Skipped webhook',
    'Record provider outcome without submitting its event.',
    'webhook',
    { skip: true },
  ],
  [
    'WEBHOOK_008',
    'Conflicting event after success',
    'Pay succeeds, then send a separate failed event after success is acknowledged.',
    'webhook',
    { pay_only: true, conflict_after_ack: true },
  ],
  [
    'WEBHOOK_011',
    'Altered amount',
    'Transmit amount increased by 1000 and sign the transmitted bytes.',
    'webhook',
    { mutate_amount: 1000 },
  ],
  [
    'WEBHOOK_013',
    'Invalid signature',
    'Send the otherwise valid event with an invalid signature.',
    'webhook',
    { invalid_signature: true },
  ],
  [
    'WEBHOOK_016',
    'Malformed signed JSON',
    'Send malformed JSON signed over those exact bytes.',
    'webhook',
    { malformed_json: true },
  ],
] as const

/**
 * Inserts or refreshes the payment and webhook failure scenarios.
 *
 * @param knex - Knex database connection.
 * @returns A promise that resolves after all scenarios are seeded.
 */
export async function seed(knex: Knex): Promise<void> {
  for (const [code, name, description, category, config] of scenarios) {
    await knex('failure_scenarios')
      .insert({ code, name, description, category, config_json: JSON.stringify(config), is_active: true })
      .onConflict('code')
      .merge({
        name,
        description,
        category,
        config_json: JSON.stringify(config),
        is_active: true,
        updated_at: knex.fn.now(),
      })
  }
}
