import type {
  DeliveryReportWebhookPayload,
  DeliveryResult,
  InboundEvent,
  InboundMessageWebhookPayload,
  SeenReportWebhookPayload,
  SeenResult,
} from '@assure-ai/infobip-types';
import { WebhookRejectionError } from './errors.js';
import { detectKind, type WebhookDelivery, type WebhookKind } from './events.js';

/** Media types a delivery may arrive as. */
const JSON_TYPES = new Set(['application/json', 'text/json', 'application/json; charset=utf-8']);

/**
 * Turn a raw body into a tagged, typed delivery.
 *
 * Structural only: it checks the envelope is `{ results: [...] }` and tags the
 * batch, and does not attempt to validate each result against the schema. The
 * platform adds fields to these payloads without notice, so a strict check here
 * would start rejecting real traffic; if you need per-field validation, run it
 * inside your handler against the result type.
 *
 * @internal
 */
export function parseDelivery(input: {
  body: string;
  contentType: string | undefined;
  kind: WebhookKind | 'auto';
}): WebhookDelivery {
  if (input.contentType !== undefined && !JSON_TYPES.has(input.contentType)) {
    // Delivery reports can be configured to arrive as XML. This package does
    // not parse XML — say so precisely instead of failing on JSON.parse.
    const hint = input.contentType.includes('xml')
      ? ' Delivery reports arrive as XML when the sending message set ' +
        '`webhooks.contentType` to application/xml — set it to application/json, ' +
        'or parse the body yourself.'
      : '';
    throw new WebhookRejectionError(
      'unsupported_content_type',
      `Expected application/json, got ${input.contentType}.${hint}`,
    );
  }

  if (input.body.trim() === '') {
    throw new WebhookRejectionError('unexpected_payload', 'The delivery had an empty body');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch (cause) {
    throw new WebhookRejectionError('malformed_json', 'The delivery body is not valid JSON', {
      cause,
    });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookRejectionError(
      'unexpected_payload',
      'Expected a JSON object with a `results` array',
    );
  }

  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new WebhookRejectionError(
      'unexpected_payload',
      'The delivery has no `results` array — every Messages API webhook carries one',
    );
  }

  const kind = input.kind === 'auto' ? detectKind(payload) : input.kind;
  if (kind === undefined) {
    throw new WebhookRejectionError(
      'unknown_kind',
      'Could not tell which webhook this is from the payload. Configure the ' +
        'receiver with an explicit `kind` for this endpoint.',
    );
  }

  switch (kind) {
    case 'delivery-report':
      return {
        kind,
        payload: payload as DeliveryReportWebhookPayload,
        results: results as DeliveryResult[],
      };
    case 'seen-report':
      return {
        kind,
        payload: payload as SeenReportWebhookPayload,
        results: results as SeenResult[],
      };
    case 'inbound-message':
      return {
        kind,
        payload: payload as InboundMessageWebhookPayload,
        results: results as InboundEvent[],
      };
  }
}

/** Normalize whatever the framework calls a body into a string. */
export function toBodyString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body === undefined || body === null) return '';
  if (typeof body === 'object') {
    // A JSON middleware already parsed it. Unlike a signed webhook, nothing
    // here depends on the exact bytes, so re-serializing is safe.
    return JSON.stringify(body);
  }
  return String(body);
}
