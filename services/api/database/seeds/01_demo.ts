import type { Knex } from 'knex'

export async function seed(knex: Knex): Promise<void> {
  await knex('users')
    .insert([
      { id: 1, first_name: 'Ada', last_name: 'User', email: 'ada.user@example.test', role: 'user', is_active: true },
      { id: 2, first_name: 'Sam', last_name: 'Admin', email: 'sam.admin@example.test', role: 'admin', is_active: true },
    ])
    .onConflict('id')
    .merge(['first_name', 'last_name', 'email', 'role', 'is_active'])

  await knex('products')
    .insert([
      { id: 1, name: 'Demo notebook', description: 'Assessment demo product', sku: 'DEMO-NOTEBOOK', price_minor: 250000, currency: 'NGN', stock_quantity: 20, is_active: true },
      { id: 2, name: 'Demo pen set', description: 'Assessment demo product', sku: 'DEMO-PENSET', price_minor: 75000, currency: 'NGN', stock_quantity: 30, is_active: true },
      { id: 3, name: 'Demo desk organiser', description: 'Assessment demo product', sku: 'DEMO-ORGANISER', price_minor: 125000, currency: 'NGN', stock_quantity: 12, is_active: true },
    ])
    .onConflict('id')
    .ignore()
}
