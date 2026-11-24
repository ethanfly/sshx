/** Readable message for any thrown value, falling back to its string form. */
export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : String(error);
}

/** Normalizes any thrown value into an Error instance. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
