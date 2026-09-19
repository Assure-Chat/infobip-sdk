import type {
  DeliveryReportWebhookPayload,
  DeliveryResult,
  InboundEvent,
  InboundMessageEvent,
  InboundMessageWebhookPayload,
  SeenReportWebhookPayload,
  SeenResult,
} from '@assure-ai/infobip-types';

/**
 * Which of the three webhooks a delivery is.
 *
 * Infobip posts each to whatever URL you registered for it, so the kind is a
 * property of *your* endpoint, not of the request — nothing in the headers says
 * which one arrived. Declare it per endpoint; {@link detectKind} exists for the
 * case where one endpoint is registered for more than one.
 */
export type WebhookKind = 'delivery-report' | 'seen-report' | 'inbound-message';

/** A parsed delivery, tagged with its kind. */
export type WebhookDelivery =
  | { kind: 'delivery-report'; payload: DeliveryReportWebhookPayload; results: DeliveryResult[] }
  | { kind: 'seen-report'; payload: SeenReportWebhookPayload; results: SeenResult[] }
  | { kind: 'inbound-message'; payload: InboundMessageWebhookPayload; results: InboundEvent[] };

/** Context handed to every handler. */
export interface WebhookContext {
  /** The kind this endpoint was configured for, or the one detected. */
  kind: WebhookKind;
  /** Request headers, as the framework supplied them. */
  headers: Record<string, string>;
  /** The raw request body, before parsing. */
  rawBody: string;
}

/** Handler for one kind of delivery. Receives the whole batch. */
export interface WebhookHandlers {
  /** Delivery reports, in one batch. */
  onDeliveryReports?: (results: DeliveryResult[], context: WebhookContext) => void | Promise<void>;
  /** Seen reports, in one batch. */
  onSeenReports?: (results: SeenResult[], context: WebhookContext) => void | Promise<void>;
  /** Every inbound event, including typing indicators. */
  onInboundEvents?: (events: InboundEvent[], context: WebhookContext) => void | Promise<void>;
  /**
   * Received messages only — the `MO` events out of `onInboundEvents`.
   *
   * Called once per message, after `onInboundEvents`. Most integrations want
   * this one; typing indicators rarely need handling.
   */
  onMessage?: (message: InboundMessageEvent, context: WebhookContext) => void | Promise<void>;
}

/**
 * Guess the kind from the payload.
 *
 * Every payload is `{ results: [...] }` and each result carries an `event`
 * discriminator, but the spec gives `event` a default on the report shapes,
 * which means a batch can legitimately arrive without one. So this falls back
 * to the fields that only one shape has — `seenAt` on a seen report, `doneAt`
 * or `status` on a delivery report — and returns undefined rather than
 * guessing when even that is ambiguous.
 *
 * Prefer declaring `kind` per endpoint. This is for the endpoint registered
 * for more than one webhook.
 */
export function detectKind(payload: unknown): WebhookKind | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return undefined;

  const first = results[0];
  if (!first || typeof first !== 'object') return undefined;
  const record = first as Record<string, unknown>;

  switch (record['event']) {
    case 'DELIVERY':
      return 'delivery-report';
    case 'SEEN':
      return 'seen-report';
    case 'MO':
    case 'TYPING_STARTED':
    case 'TYPING_STOPPED':
      return 'inbound-message';
    default:
      break;
  }

  if ('seenAt' in record) return 'seen-report';
  if ('doneAt' in record || 'status' in record) return 'delivery-report';
  if ('content' in record) return 'inbound-message';
  return undefined;
}

/** Narrow an inbound event to a received message. */
export function isInboundMessageEvent(event: InboundEvent): event is InboundMessageEvent {
  return event.event === 'MO';
}

/**
 * Run the handlers a delivery calls for.
 *
 * Returns false when no handler covered it, which the receiver reports through
 * `onUnhandled` rather than treating as an error.
 *
 * @internal
 */
export async function dispatch(
  handlers: WebhookHandlers,
  delivery: WebhookDelivery,
  context: WebhookContext,
): Promise<boolean> {
  switch (delivery.kind) {
    case 'delivery-report': {
      if (!handlers.onDeliveryReports) return false;
      await handlers.onDeliveryReports(delivery.results, context);
      return true;
    }
    case 'seen-report': {
      if (!handlers.onSeenReports) return false;
      await handlers.onSeenReports(delivery.results, context);
      return true;
    }
    case 'inbound-message': {
      let handled = false;
      if (handlers.onInboundEvents) {
        await handlers.onInboundEvents(delivery.results, context);
        handled = true;
      }
      if (handlers.onMessage) {
        for (const event of delivery.results) {
          if (isInboundMessageEvent(event)) await handlers.onMessage(event, context);
        }
        handled = true;
      }
      return handled;
    }
  }
}
