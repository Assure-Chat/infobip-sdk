import type { ApiErrorViolation } from '@assure-ai/infobip-types';

/** Base class for every error this SDK throws. */
export class InfobipError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when the client is constructed or called with unusable arguments. */
export class InfobipConfigError extends InfobipError {}

/** Thrown when a request exceeds its timeout, or the caller aborts it. */
export class InfobipTimeoutError extends InfobipError {
  /** Milliseconds the request was allowed to run. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when the request never produced an HTTP response (DNS, TLS, socket). */
export class InfobipConnectionError extends InfobipError {}

export interface InfobipApiErrorInit {
  status: number;
  /** Human-readable text, from whichever error envelope the platform sent. */
  message: string;
  /** Machine-readable `errorCode`, when the envelope carried one. */
  code?: string | undefined;
  /** What the platform says to do about it. */
  action?: string | undefined;
  /** Field-level violations, on a rejected payload. */
  violations?: ApiErrorViolation[] | undefined;
  /** The parsed response body, whatever shape it arrived in. */
  body?: unknown;
  /** Response headers, lower-cased. */
  headers?: Record<string, string>;
  method: string;
  url: string;
}

/**
 * A non-2xx response from the Messages API.
 *
 * Infobip does not use one error envelope everywhere: the Messages API routes
 * document a flat `{ errorCode, description, action, violations }`, while the
 * platform's older shared middleware answers with a nested
 * `{ requestError: { serviceException: { messageId, text } } }`, and a gateway
 * in front of either can return something else entirely. All three are folded
 * into the fields here — see {@link parseErrorBody}.
 */
export class InfobipApiError extends InfobipError {
  /** HTTP status code. */
  readonly status: number;
  /** `errorCode` (or `messageId`, on the legacy envelope), when present. */
  readonly code: string | undefined;
  /** The platform's suggested recovery action, when present. */
  readonly action: string | undefined;
  /** Field-level violations, when the failure was a rejected payload. */
  readonly violations: ApiErrorViolation[] | undefined;
  /** The parsed response body. */
  readonly body: unknown;
  /** Lower-cased response headers. */
  readonly headers: Record<string, string>;
  /** HTTP method of the failed request. */
  readonly method: string;
  /** URL of the failed request, with its query string. */
  readonly url: string;

  constructor(init: InfobipApiErrorInit) {
    super(`${init.method} ${init.url} failed with ${init.status}: ${init.message}`);
    this.status = init.status;
    this.code = init.code;
    this.action = init.action;
    this.violations = init.violations;
    this.body = init.body;
    this.headers = init.headers ?? {};
    this.method = init.method;
    this.url = init.url;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /**
   * `Retry-After` in milliseconds, when the server sent one. Handles both the
   * delay-seconds and the HTTP-date forms.
   */
  get retryAfterMs(): number | undefined {
    const raw = this.headers['retry-after'];
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
  }
}

/** 401 — the credential is missing, malformed, revoked, or expired. */
export class InfobipAuthenticationError extends InfobipApiError {}

/** 403 — authenticated, but this account may not use the route or the channel. */
export class InfobipPermissionError extends InfobipApiError {}

/** 404 — no such route or resource on this account's base URL. */
export class InfobipNotFoundError extends InfobipApiError {}

/** 400 / 422 — the payload was rejected. See {@link InfobipApiError.violations}. */
export class InfobipValidationError extends InfobipApiError {}

/** 429 — rate limited. See {@link InfobipApiError.retryAfterMs}. */
export class InfobipRateLimitError extends InfobipApiError {}

/** 5xx — the platform or a downstream channel failed. */
export class InfobipServerError extends InfobipApiError {}

/**
 * Build the most specific error class for a status code.
 *
 * @internal
 */
export function createApiError(init: InfobipApiErrorInit): InfobipApiError {
  switch (init.status) {
    case 400:
    case 422:
      return new InfobipValidationError(init);
    case 401:
      return new InfobipAuthenticationError(init);
    case 403:
      return new InfobipPermissionError(init);
    case 404:
      return new InfobipNotFoundError(init);
    case 429:
      return new InfobipRateLimitError(init);
    default:
      return init.status >= 500 ? new InfobipServerError(init) : new InfobipApiError(init);
  }
}

/** Type guard for {@link InfobipApiError}. */
export function isInfobipApiError(value: unknown): value is InfobipApiError {
  return value instanceof InfobipApiError;
}

/** What {@link parseErrorBody} could pull out of a failure response. */
export interface ParsedErrorBody {
  message: string;
  code?: string;
  action?: string;
  violations?: ApiErrorViolation[];
}

/**
 * Pull a message, code, action, and violations out of a parsed response body.
 *
 * Handles the Messages API envelope, the platform's legacy `requestError`
 * envelope, and the case where neither applies — a proxy's HTML error page, or
 * an empty body — where the status line is all there is to report.
 *
 * @internal
 */
export function parseErrorBody(body: unknown, status: number): ParsedErrorBody {
  if (typeof body === 'string' && body.trim() !== '') {
    return { message: body.slice(0, 500) };
  }
  if (body && typeof body === 'object') {
    const envelope = body as Record<string, unknown>;

    // The documented Messages API shape.
    if (typeof envelope['description'] === 'string') {
      const result: ParsedErrorBody = { message: envelope['description'] };
      if (typeof envelope['errorCode'] === 'string') result.code = envelope['errorCode'];
      if (typeof envelope['action'] === 'string') result.action = envelope['action'];
      if (Array.isArray(envelope['violations'])) {
        result.violations = envelope['violations'] as ApiErrorViolation[];
      }
      return result;
    }

    // The platform's shared middleware, which predates the Messages API.
    const requestError = envelope['requestError'];
    if (requestError && typeof requestError === 'object') {
      const exception = (requestError as Record<string, unknown>)['serviceException'];
      if (exception && typeof exception === 'object') {
        const detail = exception as Record<string, unknown>;
        const result: ParsedErrorBody = {
          message: typeof detail['text'] === 'string' ? detail['text'] : `HTTP ${status}`,
        };
        if (typeof detail['messageId'] === 'string') result.code = detail['messageId'];
        return result;
      }
    }
  }
  return { message: `HTTP ${status}` };
}
