export class FdcError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = options?.status;
  }
}

export class FdcConfigError extends FdcError {}

export class FdcAuthError extends FdcError {}

export class FdcBadRequestError extends FdcError {}

export class FdcNotFoundError extends FdcError {}

export class FdcRateLimitError extends FdcError {
  readonly retryAfterMs: number;
  readonly retryAt: Date;

  constructor(message: string, retryAfterMs: number, options?: { status?: number; cause?: unknown }) {
    super(message, { status: options?.status ?? 429, cause: options?.cause });
    this.retryAfterMs = retryAfterMs;
    this.retryAt = new Date(Date.now() + retryAfterMs);
  }
}

export class FdcServerError extends FdcError {}

export class FdcTimeoutError extends FdcError {}

export class FdcNetworkError extends FdcError {}

export class FdcResponseError extends FdcError {}
