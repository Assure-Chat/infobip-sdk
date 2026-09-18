import type { AuthorizationProvider } from './auth.js';
import {
  InfobipConnectionError,
  InfobipTimeoutError,
  createApiError,
  isInfobipApiError,
  parseErrorBody,
} from './errors.js';

/** The subset of `fetch` this SDK relies on. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Query values the SDK knows how to serialize. */
export type QueryValue = string | number | boolean | undefined | null | (string | number)[];

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue> | undefined;
  /** JSON body. */
  body?: unknown;
  headers?: Record<string, string | undefined> | undefined;
  /**
   * Whether replaying this request after an *unknown* outcome is safe.
   *
   * Not "is it a GET". Nothing in this API is safe to replay blind:
   *
   * - A send is a POST with no idempotency key, so a replay after a timeout can
   *   deliver the message twice.
   * - The two pull queues are destructive reads — each report and each inbound
   *   message is handed out once — so a replay can return the *next* batch
   *   while the batch the first attempt dequeued is gone.
   *
   * A failure the server describes is different: see {@link REFUSED_STATUSES}.
   * Those are retried whatever this says, because the server has stated it did
   * nothing. Default false.
   */
  replaySafe?: boolean;
  /** Overrides the client-level timeout for this one request. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Treat these non-2xx statuses as results rather than failures. The validate
   * route answers a well-formed "this payload is invalid" with a 400.
   */
  acceptStatuses?: readonly number[] | undefined;
}

/** Called before each attempt, including retries. */
export type RequestHook = (info: {
  method: string;
  url: string;
  headers: Record<string, string>;
  attempt: number;
}) => void | Promise<void>;

/** Called after each response, including ones that will be retried. */
export type ResponseHook = (info: {
  method: string;
  url: string;
  status: number;
  attempt: number;
  durationMs: number;
}) => void | Promise<void>;

export interface RetryOptions {
  /** Retry attempts after the initial one. Default 2. Set 0 to disable. */
  maxRetries?: number;
  /** Base backoff in ms; doubles per attempt. Default 500. */
  initialDelayMs?: number;
  /** Ceiling for a single backoff delay. Default 8000. */
  maxDelayMs?: number;
}

export interface HttpClientOptions {
  baseUrl: string;
  authorization: AuthorizationProvider;
  fetch?: FetchLike | undefined;
  timeoutMs?: number;
  retry?: RetryOptions;
  /** Headers merged into every request. Per-request headers win. */
  headers?: Record<string, string>;
  userAgent?: string;
  onRequest?: RequestHook | undefined;
  onResponse?: ResponseHook | undefined;
}

/** A response the caller asked to see even though it was not a 2xx. */
export interface HttpResult<T> {
  status: number;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Statuses that say the server did not act on the request.
 *
 * A 429 is a refusal at the rate limiter, a 503 is a refusal at the front door,
 * and a 408 is the server discarding a request it never finished reading. In
 * each case nothing was processed, so replaying is safe even for a send that
 * would otherwise be unsafe to repeat.
 *
 * Deliberately excludes 500, 502, and 504: those are ambiguous. The request may
 * have been fully processed and only the response lost, so retrying one is a
 * decision for the caller, through `replaySafe`.
 */
export const REFUSED_STATUSES: readonly number[] = [408, 429, 503];

/**
 * The transport every resource goes through: URL building, the `Authorization`
 * header, timeouts, retries with jittered backoff, and error normalization.
 *
 * @internal
 */
export class HttpClient {
  readonly baseUrl: string;
  readonly #authorization: AuthorizationProvider;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #headers: Record<string, string>;
  readonly #userAgent: string;
  readonly #onRequest: RequestHook | undefined;
  readonly #onResponse: ResponseHook | undefined;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.retry?.maxRetries ?? 2;
    this.#initialDelayMs = options.retry?.initialDelayMs ?? 500;
    this.#maxDelayMs = options.retry?.maxDelayMs ?? 8_000;
    this.#headers = options.headers ?? {};
    this.#userAgent = options.userAgent ?? '@assure/infobip-api';
    this.#onRequest = options.onRequest;
    this.#onResponse = options.onResponse;
  }

  /** Perform a request and decode its JSON body, throwing on failure. */
  async request<T>(options: RequestOptions): Promise<T> {
    return (await this.requestWithStatus<T>(options)).data;
  }

  /** As {@link request}, but hands back the status alongside the body. */
  async requestWithStatus<T>(options: RequestOptions): Promise<HttpResult<T>> {
    const url = this.buildUrl(options.path, options.query);
    const method = options.method;
    const replaySafe = options.replaySafe ?? false;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const accepted = options.acceptStatuses ?? [];

    let attempt = 0;
    let reauthorized = false;

    for (;;) {
      attempt += 1;
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': this.#userAgent,
        ...lowerCaseKeys(this.#headers),
        ...lowerCaseKeys(options.headers ?? {}),
      };

      let body: string | undefined;
      if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers['content-type'] ??= 'application/json';
      }

      headers['authorization'] = await this.#authorization.getAuthorization({
        ...(options.signal ? { signal: options.signal } : {}),
      });

      await this.#onRequest?.({ method, url, headers, attempt });

      const startedAt = Date.now();
      const { signal, dispose } = withTimeout(timeoutMs, options.signal);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal,
        });
      } catch (cause) {
        dispose();
        const aborted = options.signal?.aborted === true;
        const error = aborted
          ? new InfobipTimeoutError(`${method} ${url} was aborted by the caller`, timeoutMs, {
              cause,
            })
          : isAbortError(cause)
            ? new InfobipTimeoutError(`${method} ${url} timed out after ${timeoutMs}ms`, timeoutMs, {
                cause,
              })
            : new InfobipConnectionError(
                `${method} ${url} failed before a response: ${describe(cause)}`,
                { cause },
              );
        // The outcome is unknown here — the request may have been processed and
        // only the response lost — so only a replay-safe route may try again.
        // A caller-triggered abort is final either way.
        if (aborted || !replaySafe || attempt > this.#maxRetries) throw error;
        await sleep(this.#backoffMs(attempt));
        continue;
      }
      dispose();

      await this.#onResponse?.({
        method,
        url,
        status: response.status,
        attempt,
        durationMs: Date.now() - startedAt,
      });

      const payload = await decodeBody(response);
      if (response.ok || accepted.includes(response.status)) {
        return { status: response.status, data: payload as T };
      }

      const parsed = parseErrorBody(payload, response.status);
      const error = createApiError({
        status: response.status,
        message: parsed.message,
        code: parsed.code,
        action: parsed.action,
        violations: parsed.violations,
        body: payload,
        headers: headersToObject(response.headers),
        method,
        url,
      });

      // A 401 can mean a minted token expired early — re-derive it and retry once.
      if (response.status === 401 && !reauthorized) {
        reauthorized = true;
        this.#authorization.invalidate();
        continue;
      }

      // A refusal is safe to replay whatever the route is: the server said it
      // did nothing. An ambiguous 5xx needs the route to be replay-safe.
      const refused = REFUSED_STATUSES.includes(response.status);
      const retryable = refused || (replaySafe && isInfobipApiError(error) && error.retryable);
      if (retryable && attempt <= this.#maxRetries) {
        await sleep(error.retryAfterMs ?? this.#backoffMs(attempt));
        continue;
      }

      throw error;
    }
  }

  /** Resolve a path and query into an absolute URL. */
  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path.replace(/^\/+/, ''), `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Exponential backoff with full jitter, capped at `maxDelayMs`. */
  #backoffMs(attempt: number): number {
    const ceiling = Math.min(this.#initialDelayMs * 2 ** (attempt - 1), this.#maxDelayMs);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }
}

function lowerCaseKeys(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function decodeBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (text === '') return undefined;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Combine a timeout with the caller's signal, without leaking the timer. */
function withTimeout(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) onAbort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === 'AbortError' || value.name === 'TimeoutError');
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
