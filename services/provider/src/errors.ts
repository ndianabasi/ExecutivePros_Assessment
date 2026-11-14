/**
 * Represents a provider HTTP failure with its status code, machine code, and safe message.
 */
export class ProviderHttpError extends Error {
  /**
   * function Object() { [native code] }
   *
   * @param status - Validated state used to determine the permitted transition.
   * @param code - Validated scenario, error, or incident code used to select the associated behavior.
   * @param message - Safe human-readable message shown to the API caller or demo user.
   */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}
