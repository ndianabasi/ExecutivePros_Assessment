import vine, { errors } from '@vinejs/vine'
import type { SchemaTypes } from '@vinejs/vine/types'
import { ProviderHttpError } from './errors.js'

function exactFields(allowed: readonly string[]) {
  const fields = new Set(allowed)
  return vine.createRule((value, _options, field) => {
    if (vine.helpers.isObject(value) && Object.keys(value).some((key) => !fields.has(key))) field.report('Unknown field', 'unknown_fields', field)
  })
}
const expiryFormat = vine.createRule((value, _options, field) => {
  if (typeof value === 'string' && (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))) {
    field.report('Expected a UTC ISO timestamp', 'utc_iso', field)
  }
})

export const authorizationValidator = vine.create(vine.object({
  authorization: vine.string().regex(/^Bearer [A-Za-z0-9_-]{32,}$/),
}).use(exactFields(['authorization'])()))
export const requestIdValidator = vine.create(vine.object({
  request_id: vine.string().minLength(1).maxLength(128).regex(/^[A-Za-z0-9._:-]+$/),
}).use(exactFields(['request_id'])()))
export const initializeValidator = vine.create(vine.object({
  reference: vine.string().minLength(8).maxLength(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/),
  amount: vine.number({ strict: true }).positive().max(Number.MAX_SAFE_INTEGER).withoutDecimals(),
  currency: vine.literal('NGN'),
  checkout_expires_at: vine.string().use(expiryFormat()),
  failure_scenario_code: vine.string().minLength(1).maxLength(64).regex(/^[A-Z0-9_]+$/).optional() as unknown as SchemaTypes,
}).use(exactFields(['reference', 'amount', 'currency', 'checkout_expires_at', 'failure_scenario_code'])()))
export const referenceValidator = vine.create(vine.object({
  reference: vine.string().minLength(8).maxLength(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/),
}).use(exactFields(['reference'])()))
export const checkoutTokenValidator = vine.create(vine.object({
  token: vine.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).use(exactFields(['token'])()))
export const submitValidator = vine.create(vine.object({
  checkout_token: vine.string().regex(/^[A-Za-z0-9_-]{43}$/),
  outcome: vine.string().in(['success', 'failed', 'cancelled']),
}).use(exactFields(['checkout_token', 'outcome'])()))

type Validator = ReturnType<typeof vine.create>
export async function validate<T>(validator: Validator, value: unknown, code = 'invalid_input', message = 'Request data is invalid'): Promise<T> {
  try { return await validator.validate(value) as T }
  catch (error) {
    if (!(error instanceof errors.E_VALIDATION_ERROR)) throw error
    const messages = error.messages as Array<{ field: string; rule: string }>
    const unknown = messages.some((item) => item.rule === 'unknown_fields')
    throw new ProviderHttpError(unknown ? 400 : 422, unknown ? 'unknown_field' : code, unknown ? 'Request contains an unsupported field' : message)
  }
}
