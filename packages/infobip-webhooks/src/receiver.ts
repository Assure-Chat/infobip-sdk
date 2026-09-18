import { authorizeDelivery, type WebhookAuthorization } from './authorization.js';
import { isWebhookRejectionError } from './errors.js';
import {
  dispatch,
  type WebhookContext,
  type WebhookDelivery,
  type WebhookHandlers,
  type WebhookKind,
} from './events.js';
import { getContentType, getHeader, type HeadersLike } from './headers.js';
import { parseDelivery, toBodyString } from './parse.js';

/** Suppresses repeat handling of a delivery already processed. */
export interface DeduplicationCache {
  /** True when this key has been seen. Records it either way. */
  seen(key: string): boolean | Promise<boolean>;
}

export interface WebhookReceiverOptions extends WebhookHandlers {
  /**
   * Which webhook this endpoint is registered for.
   *
   * Required, and deliberately so: nothing in the request says which of the
   * three arrived, and getting it wrong means handing a seen report to the
   * delivery-report handler. Use `'auto'` only for an endpoint registered for
   * more than one, where it is inferred from the payload.
   */
  kind: WebhookKind | 'auto';
  /**
   * How to establish the delivery is genuine. Required — Infobip does not sign
   * these webhooks, so the choice has to be yours. See {@link WebhookAuthorization}.
   */
  authorization: WebhookAuthorization;
  /** Called for every accepted delivery, before the per-kind handlers. */
  onDelivery?: (delivery: WebhookDelivery, context: WebhookContext) => void | Promise<void>;
  /** Called when no handler covered an accepted delivery. */
  onUnhandled?: (delivery: WebhookDelivery, context: WebhookContext) => void | Promise<void>;
  /**
   * Called when a delivery is rejected or a handler throws. For logging — the
   * HTTP status is decided by the receiver either way.
   */
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Drops repeat deliveries. Infobip retries a callback that did not return a
   * 2xx, so a handler that succeeded slowly can be asked to run again.
   */
  deduplicate?: DeduplicationCache;
  /**
   * Builds the deduplication key for a delivery. Defaults to the `messageId`s
   * in the batch, which is what the platform retries at.
   */
  deduplicationKey?: (delivery: WebhookDelivery, context: WebhookContext) => string | undefined;
}

/** What the receiver decided the HTTP response should be. */
export interface WebhookResult {
  /** Status to return: 2xx acknowledges, anything else asks for a retry. */
  status: number;
  /** JSON-serializable body. */
  body: { ok: true } | { ok: false; error: string; code?: string };
  /** The parsed delivery, when it was accepted. */
  delivery?: WebhookDelivery;
}

/**
 * Framework-agnostic core: authorize a delivery, parse it, dispatch it, and
 * decide the response. Every adapter in this package wraps this.
 *
 * The status mapping follows what the platform does with each:
 *
 * - `200` — accepted and handled, or a duplicate already handled.
 * - `401` — the authorization check rejected it.
 * - `400` — the body was not something this package could parse. Retrying will
 *   not change that, but the platform retries regardless and the answer is the
 *   same each time.
 * - `500` — a handler threw. The platform retries, which is what you want for
 *   a transient failure in your own code.
 */
export class WebhookReceiver {
  readonly #options: WebhookReceiverOptions;

  constructor(options: WebhookReceiverOptions) {
    this.#options = options;
  }

  /** Process one delivery. */
  async handle(input: { headers: HeadersLike; body: unknown }): Promise<WebhookResult> {
    const rawBody = toBodyString(input.body);
    const headers = collectHeaders(input.headers);

    let delivery: WebhookDelivery;
    try {
      await authorizeDelivery(this.#options.authorization, { headers: input.headers, body: rawBody });
      delivery = parseDelivery({
        body: rawBody,
        contentType: getContentType(input.headers),
        kind: this.#options.kind,
      });
    } catch (error) {
      await this.#options.onError?.(error);
      const code = isWebhookRejectionError(error) ? error.code : 'unexpected_payload';
      return {
        status: code === 'unauthorized' ? 401 : 400,
        body: { ok: false, error: describe(error), code },
      };
    }

    const context: WebhookContext = { kind: delivery.kind, headers, rawBody };

    if (this.#options.deduplicate) {
      const key = (this.#options.deduplicationKey ?? defaultDeduplicationKey)(delivery, context);
      if (key !== undefined && (await this.#options.deduplicate.seen(key))) {
        // Already handled — acknowledge so the platform stops retrying.
        return { status: 200, body: { ok: true }, delivery };
      }
    }

    try {
      await this.#options.onDelivery?.(delivery, context);
      const handled = await dispatch(this.#options, delivery, context);
      if (!handled) await this.#options.onUnhandled?.(delivery, context);
    } catch (error) {
      await this.#options.onError?.(error);
      // Non-2xx so the platform retries — the delivery is real, our side failed.
      return { status: 500, body: { ok: false, error: describe(error) }, delivery };
    }

    return { status: 200, body: { ok: true }, delivery };
  }
}

/**
 * The batch's message ids, joined.
 *
 * A single id is not enough: one callback carries a batch, and the platform
 * retries the batch rather than its parts.
 */
function defaultDeduplicationKey(delivery: WebhookDelivery): string | undefined {
  const ids = (delivery.results as ReadonlyArray<{ messageId?: string }>)
    .map((result) => result.messageId)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return undefined;
  return `${delivery.kind}:${ids.join(',')}`;
}

/** Flatten headers into a plain record for the handler context. */
function collectHeaders(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof (headers as Headers).forEach === 'function' && !(headers instanceof Map)) {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (headers instanceof Map) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    // Opaque accessor — surface the headers this package reads by name.
    for (const name of ['content-type', 'authorization', 'user-agent']) {
      const value = getHeader(headers, name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
