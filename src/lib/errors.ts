/** Errors that carry a message we are happy to show the Telegram user. */

export class UserFacingError extends Error {
  constructor(
    public readonly userText: string,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(`${code}: ${detail ?? userText}`);
    this.name = 'UserFacingError';
  }
}

export function isUserFacing(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

export function logError(scope: string, error: unknown, extra?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(JSON.stringify({ scope, message, stack, ...extra }));
}
