import type { ApiConfig } from './config.js'

export interface EmailJob {
  type: 'email'
  notification_key: string
  to: string
  subject: string
  text: string
  html?: string
  payment_reference?: string
}

export class QueueRequestError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'QueueRequestError'
  }
}

async function readBounded(response: Response, maxBytes = 4096): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < maxBytes) {
    const next = await reader.read()
    if (next.done) break
    const chunk = next.value.subarray(0, maxBytes - size)
    chunks.push(chunk)
    size += chunk.byteLength
    if (chunk.byteLength < next.value.byteLength) break
  }
  await reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks).toString('utf8')
}

export class EmailQueueClient {
  constructor(private readonly baseUrl: string, private readonly secret: string, private readonly timeoutMs: number) {}

  async enqueue(job: EmailJob, requestId: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(new URL('/jobs', `${this.baseUrl}/`), {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(job),
      })
      const raw = await readBounded(response)
      if (response.status !== 202) throw new QueueRequestError(`Queue returned HTTP ${response.status}`, response.status)
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new QueueRequestError('Queue returned an invalid acceptance response', response.status) }
      if (typeof body !== 'object' || body === null || !('job_id' in body) || typeof body.job_id !== 'string' || !body.job_id ||
          !('status' in body) || body.status !== 'queued') {
        throw new QueueRequestError('Queue returned an invalid acceptance response', response.status)
      }
      return body.job_id
    } catch (error) {
      if (error instanceof QueueRequestError) throw error
      throw new QueueRequestError(error instanceof Error && error.name === 'AbortError' ? 'Queue request timed out' : 'Queue request failed')
    } finally { clearTimeout(timeout) }
  }
}

export function createEmailQueueClient(config: ApiConfig): EmailQueueClient {
  return new EmailQueueClient(config.queueBaseUrl, config.queueServiceSecret, config.queueTimeoutMs)
}
