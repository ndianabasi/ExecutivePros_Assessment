import vine, { errors } from '@vinejs/vine'
import type { SchemaTypes } from '@vinejs/vine/types'
import { HttpError } from './errors.js'

type Validator = ReturnType<typeof vine.create>

function exactFields(allowed: readonly string[]) {
  const fields = new Set(allowed)
  return vine.createRule((value, _options, field) => {
    if (vine.helpers.isObject(value) && Object.keys(value).some((key) => !fields.has(key))) {
      field.report('Unknown request field', 'unknown_fields', field)
    }
  })
}
const matchingWebhookStatus = vine.createRule((value, _options, field) => {
  if (vine.helpers.isObject(value) && value.event_type !== `payment.${String(value.status)}`) {
    field.report('event_type must match status', 'event_status_mismatch', field)
  }
})

export const loginValidator = vine.create(vine.object({
  user_id: vine.number({ strict: true }).positive().withoutDecimals(),
}).use(exactFields(['user_id'])()))

export const productQueryValidator = vine.create(vine.object({
  page: vine.number().positive().withoutDecimals().optional() as unknown as SchemaTypes,
  page_size: vine.number().positive().max(100).withoutDecimals().optional() as unknown as SchemaTypes,
}).use(exactFields(['page', 'page_size'])()))

export const cartItemsValidator = vine.create(vine.object({
  items: vine.array(vine.object({
    product_id: vine.number({ strict: true }).positive().withoutDecimals(),
    quantity: vine.number({ strict: true }).positive().withoutDecimals(),
  }).use(exactFields(['product_id', 'quantity'])())).minLength(1).maxLength(50),
}).use(exactFields(['items'])()))

export const cartItemUpdateValidator = vine.create(vine.object({
  quantity: vine.number({ strict: true }).positive().withoutDecimals(),
}).use(exactFields(['quantity'])()))

export const positiveIdValidator = vine.create(vine.object({
  id: vine.number().positive().withoutDecimals(),
}).use(exactFields(['id'])()))

export const pageQueryValidator = vine.create(vine.object({
  page: vine.number().positive().withoutDecimals().optional() as unknown as SchemaTypes,
  page_size: vine.number().positive().max(100).withoutDecimals().optional() as unknown as SchemaTypes,
}).use(exactFields(['page', 'page_size'])()))

export const idempotencyHeaderValidator = vine.create(vine.object({
  key: vine.string().minLength(8).maxLength(128).regex(/^[A-Za-z0-9._:-]+$/),
}).use(exactFields(['key'])()))

export const authorizationHeaderValidator = vine.create(vine.object({
  authorization: vine.string().regex(/^Bearer [A-Za-z0-9_-]{32,}$/),
}).use(exactFields(['authorization'])()))

export const requestIdHeaderValidator = vine.create(vine.object({
  request_id: vine.string().minLength(1).maxLength(128).regex(/^[A-Za-z0-9._:-]+$/),
}).use(exactFields(['request_id'])()))

export const webhookSignatureValidator = vine.create(vine.object({
  signature: vine.string().regex(/^sha256=[a-f0-9]{64}$/),
}).use(exactFields(['signature'])()))

export const webhookReferenceValidator = vine.create(vine.object({
  reference: vine.string().minLength(20).maxLength(88).regex(/^pay_[A-Za-z0-9_-]{16,80}$/),
}).use(exactFields(['reference'])()))

export const checkoutValidator = vine.create(vine.object({
  cart_id: vine.number({ strict: true }).positive().withoutDecimals().optional() as unknown as SchemaTypes,
  failure_scenario_code: vine.string().minLength(1).maxLength(64).regex(/^[A-Z0-9_]+$/).optional() as unknown as SchemaTypes,
}).use(exactFields(['cart_id', 'failure_scenario_code'])()))

export const webhookValidator = vine.create(vine.object({
  event_id: vine.string().minLength(1).maxLength(128).regex(/^[A-Za-z0-9._:-]+$/),
  event_type: vine.string().in(['payment.success', 'payment.failed', 'payment.cancelled']),
  status: vine.string().in(['success', 'failed', 'cancelled']),
  reference: vine.string().minLength(20).maxLength(88).regex(/^pay_[A-Za-z0-9_-]{16,80}$/),
  provider_reference: vine.string().maxLength(160).optional() as unknown as SchemaTypes,
  amount: vine.number({ strict: true }).positive().withoutDecimals(),
  currency: vine.literal('NGN'),
  occurred_at: vine.string().maxLength(64).regex(/^\d{4}-\d\d-\d\dT/).optional() as unknown as SchemaTypes,
}).use(exactFields(['event_id', 'event_type', 'status', 'reference', 'provider_reference', 'amount', 'currency', 'occurred_at'])()).use(matchingWebhookStatus()))

export async function validate<T>(validator: Validator, input: unknown, code = 'invalid_input', message = 'Request data is invalid', status: 400 | 422 = 400): Promise<T> {
  try {
    return await validator.validate(input) as T
  } catch (error) {
    if (!(error instanceof errors.E_VALIDATION_ERROR)) throw error
    const messages = error.messages as Array<{ field: string; rule: string }>
    const details = messages.map((item) => ({ field: item.field, rule: item.rule }))
    const unknownFields = details.some((item) => item.rule === 'unknown_fields')
    throw new HttpError(status, unknownFields ? 'unknown_field' : code, unknownFields ? 'Request contains an unsupported field' : message, details)
  }
}
