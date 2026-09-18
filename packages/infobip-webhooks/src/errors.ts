/** Why a delivery was rejected. Every value means: do not process the body. */
export type WebhookRejectionCode =
  | 'unauthorized'
  | 'unsupported_content_type'
  | 'malformed_json'
  | 'unexpected_payload'
  | 'unknown_kind'
  | 'duplicate';

/**
 * Thrown when a delivery is rejected before any handler sees it.
 *
 * `duplicate` is the one code that is not a failure: the delivery was already
 * handled, so it should be acknowledged with a 2xx and dropped.
 */
export class WebhookRejectionError extends Error {
  readonly code: WebhookRejectionCode;

  constructor(code: WebhookRejectionCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebhookRejectionError';
    this.code = code;
  }
}

/** Type guard for {@link WebhookRejectionError}. */
export function isWebhookRejectionError(value: unknown): value is WebhookRejectionError {
  return value instanceof WebhookRejectionError;
}
