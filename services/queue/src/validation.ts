import { randomUUID } from 'node:crypto'
import vine, { errors } from '@vinejs/vine'
import type { SchemaTypes } from '@vinejs/vine/types'
import type { Request } from 'express'
import type { EmailJob } from './jobs.js'

export type ValidationResult = { ok: true; value: EmailJob } | { ok: false; status: 400 | 422; message: string }

const allowedFields = new Set(['type', 'notification_key', 'to', 'subject', 'text', 'html', 'payment_reference'])
const rejectUnknownFields = vine.createRule((value, _options, field) => {
  if (!vine.helpers.isObject(value)) return
  if (Object.keys(value).some((key) => !allowedFields.has(key))) {
    field.report('Unknown request field', 'unknown_fields', field)
  }
})

const emailJobValidator = vine.create(vine.object({
  type: vine.literal('email'),
  notification_key: vine.string().minLength(1).maxLength(200).regex(/^[\x20-\x7e]+$/),
  to: vine.string().email().maxLength(254),
  subject: vine.string().minLength(1).maxLength(200).regex(/^[^\r\n\x00-\x1f\x7f]+$/),
  text: vine.string().minLength(1).maxLength(20000).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/),
  html: vine.string().maxLength(40000).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/).optional() as unknown as SchemaTypes,
  payment_reference: vine.string().minLength(1).maxLength(200).regex(/^[^\x00-\x1f\x7f]+$/).optional() as unknown as SchemaTypes,
}).use(rejectUnknownFields()))

const requestIdValidator = vine.create(vine.object({
    value: vine.string().maxLength(128).regex(/^[A-Za-z0-9._:-]+$/).optional() as unknown as SchemaTypes,
}))

export async function requestId(request: Request): Promise<string> {
  const candidate = request.header('x-request-id')?.trim()
  if (!candidate) return randomUUID()
  try {
    const value = await requestIdValidator.validate({ value: candidate })
    return value.value ?? randomUUID()
  } catch (error) {
    if (error instanceof errors.E_VALIDATION_ERROR) return randomUUID()
    throw error
  }
}

export async function validateEmailJob(body: unknown, id: string): Promise<ValidationResult> {
  try {
    const value = await emailJobValidator.validate(body) as unknown as Omit<EmailJob, 'request_id'>
    return { ok: true, value: { ...value, request_id: id } }
  } catch (error) {
    if (!(error instanceof errors.E_VALIDATION_ERROR)) throw error
    const messages = error.messages as Array<{ field?: string; rule?: string }>
    if (messages.some((item) => item.rule === 'unknown_fields')) return { ok: false, status: 400, message: 'Unknown request field' }
    if (messages.some((item) => item.field === 'type')) return { ok: false, status: 400, message: 'Unsupported job type' }
    if (messages.some((item) => item.rule === 'object')) return { ok: false, status: 400, message: 'Expected a JSON object' }
    return { ok: false, status: 422, message: 'Email job fields are invalid' }
  }
}
