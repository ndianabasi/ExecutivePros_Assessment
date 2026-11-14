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

/**
 * Represents a queue submission failure with the HTTP status needed for retry decisions.
 */
export class QueueRequestError extends Error {
  /**
   * function Object() { [native code] }
   *
   * @param message - Safe human-readable message shown to the API caller or demo user.
   * @param status - Validated state used to determine the permitted transition.
   */
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'QueueRequestError'
  }
}

/**
 * Reads a response body up to a strict byte limit so a dependency cannot return unbounded data.
 *
 * @param response - HTTP response or upstream dependency response whose status and body are handled by this operation.
 * @param maxBytes - Maximum number of response bytes accepted before the body is treated as oversized.
 *
 * @returns The requested value or matching records from the configured service source.
 */
async function readBounded(response: Response, maxBytes = 4096): Promise<string> {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < maxBytes) {
    const next = await reader.read()
    if (next.done) {
      break
    }
    const chunk = next.value.subarray(0, maxBytes - size)
    chunks.push(chunk)
    size += chunk.byteLength
    if (chunk.byteLength < next.value.byteLength) {
      break
    }
  }
  await reader.cancel().catch(() => {
    return undefined
  })
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Provides the EmailQueueClient implementation used by the api service.
 */
export class EmailQueueClient {
  /**
   * function Object() { [native code] }
   *
   * @param baseUrl - Fixed service base URL used to construct authenticated outbound requests.
   * @param secret - Configured service credential or webhook secret used at the authentication boundary.
   * @param timeoutMs - Maximum duration allowed for this network operation before it is aborted.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Sends or delivers enqueue through the configured service boundary and reports its outcome.
   *
   * @param job - Validated email notification job to submit or deliver.
   * @param requestId - Validated correlation identifier attached to the request or queued notification.
   *
   * @returns The queue acceptance result for the idempotent notification job.
   */
  async enqueue(job: EmailJob, requestId: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      return controller.abort()
    }, this.timeoutMs)
    try {
      const response = await fetch(new URL('/jobs', `${this.baseUrl}/`), {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(job),
      })
      const raw = await readBounded(response)
      if (response.status !== 202) {
        throw new QueueRequestError(`Queue returned HTTP ${response.status}`, response.status)
      }
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        throw new QueueRequestError('Queue returned an invalid acceptance response', response.status)
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        !('job_id' in body) ||
        typeof body.job_id !== 'string' ||
        !body.job_id ||
        !('status' in body) ||
        body.status !== 'queued'
      ) {
        throw new QueueRequestError('Queue returned an invalid acceptance response', response.status)
      }
      return body.job_id
    } catch (error) {
      if (error instanceof QueueRequestError) {
        throw error
      }
      throw new QueueRequestError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Queue request timed out'
          : 'Queue request failed',
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * Creates the authenticated queue client from validated API configuration.
 *
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createEmailQueueClient(config: ApiConfig): EmailQueueClient {
  return new EmailQueueClient(config.queueBaseUrl, config.queueServiceSecret, config.queueTimeoutMs)
}
