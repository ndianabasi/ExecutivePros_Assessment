/**
 * Represents an expected API HTTP failure with a stable status, code, message, and request ID.
 */
export class HttpError extends Error {
  /**
   * function Object() { [native code] }
   *
   * @param status - Validated state used to determine the permitted transition.
   * @param code - Validated scenario, error, or incident code used to select the associated behavior.
   * @param message - Safe human-readable message shown to the API caller or demo user.
   * @param details - Input value used by this operation.
   */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
