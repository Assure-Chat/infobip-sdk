/**
 * `@assure-ai/infobip-webhooks` — receivers for the three Messages API webhooks.
 *
 * ```ts
 * import { WebhookReceiver } from '@assure-ai/infobip-webhooks';
 *
 * const receiver = new WebhookReceiver({
 *   kind: 'inbound-message',
 *   authorization: { secret: process.env.INFOBIP_WEBHOOK_SECRET! },
 *   onMessage: async (message) => { await enqueue(message); },
 * });
 *
 * const result = await receiver.handle({ headers, body });
 * ```
 *
 * **On authenticity.** Infobip does not sign these callbacks — the OpenAPI
 * document declares no signature header and no `security` on any of the three
 * webhook operations. So this package cannot verify a signature, and does not
 * pretend to: {@link WebhookAuthorization} checks the credential *you* attached
 * to the callback URL you registered. Choosing `'none'` is allowed but has to
 * be written down, so no endpoint ends up unauthenticated by omission.
 */
export {
  DEFAULT_SECRET_HEADER,
  timingSafeEqual,
  type WebhookAuthorization,
} from './authorization.js';

export {
  WebhookRejectionError,
  isWebhookRejectionError,
  type WebhookRejectionCode,
} from './errors.js';

export {
  detectKind,
  isInboundMessageEvent,
  type WebhookContext,
  type WebhookDelivery,
  type WebhookHandlers,
  type WebhookKind,
} from './events.js';

export { getContentType, getHeader, type HeadersLike } from './headers.js';

export {
  WebhookReceiver,
  type DeduplicationCache,
  type WebhookReceiverOptions,
  type WebhookResult,
} from './receiver.js';

// Re-exported so a consumer needs one dependency for the common path.
export type {
  DeliveryReportWebhookPayload,
  DeliveryResult,
  InboundContent,
  InboundEvent,
  InboundMessageEvent,
  InboundMessageWebhookPayload,
  SeenReportWebhookPayload,
  SeenResult,
} from '@assure-ai/infobip-types';
