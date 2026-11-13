import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary()
    table.string('first_name').notNullable()
    table.string('last_name').notNullable()
    table.string('email').notNullable().unique()
    table.enu('role', ['user', 'admin']).notNullable().defaultTo('user')
    table.boolean('is_active').notNullable().defaultTo(true)
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('user_tokens', (table) => {
    table.increments('id').primary()
    table.integer('user_id').notNullable().references('users.id').onDelete('CASCADE')
    table.string('token_hash').notNullable().unique()
    table.timestamp('expires_at').notNullable()
    table.timestamp('revoked_at').nullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })
  await knex.raw('CREATE UNIQUE INDEX users_email_nocase ON users(email COLLATE NOCASE)')
  await knex.raw('CREATE INDEX user_tokens_user_expiry ON user_tokens(user_id, expires_at)')

  await knex.schema.createTable('products', (table) => {
    table.increments('id').primary()
    table.string('name').notNullable()
    table.text('description').notNullable().defaultTo('')
    table.integer('price_minor').notNullable()
    table.string('currency').notNullable().defaultTo('NGN')
    table.integer('stock_quantity').notNullable().defaultTo(0)
    table.integer('stock_reserved').notNullable().defaultTo(0)
    table.boolean('is_active').notNullable().defaultTo(true)
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.check('price_minor >= 0')
    table.check('stock_quantity >= 0')
    table.check('stock_reserved >= 0 AND stock_reserved <= stock_quantity')
  })

  await knex.schema.createTable('carts', (table) => {
    table.increments('id').primary()
    table.integer('user_id').notNullable().references('users.id')
    table.enu('status', ['active', 'checked_out', 'paid', 'abandoned']).notNullable().defaultTo('active')
    table.string('currency').notNullable().defaultTo('NGN')
    table.integer('total_minor').notNullable().defaultTo(0)
    table.timestamp('paid_at').nullable()
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
    table.check('total_minor >= 0')
  })
  await knex.raw("CREATE UNIQUE INDEX carts_one_active_per_user ON carts(user_id) WHERE status = 'active'")

  await knex.schema.createTable('cart_items', (table) => {
    table.increments('id').primary()
    table.integer('cart_id').notNullable().references('carts.id').onDelete('CASCADE')
    table.integer('product_id').notNullable().references('products.id')
    table.string('product_name').notNullable()
    table.integer('unit_price_minor').notNullable()
    table.integer('quantity').notNullable()
    table.integer('line_total_minor').notNullable()
    table.unique(['cart_id', 'product_id'])
    table.check('unit_price_minor >= 0 AND quantity > 0 AND line_total_minor >= 0')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cart_items')
  await knex.schema.dropTableIfExists('carts')
  await knex.schema.dropTableIfExists('products')
  await knex.schema.dropTableIfExists('user_tokens')
  await knex.schema.dropTableIfExists('users')
}
