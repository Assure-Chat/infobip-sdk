import { WebhookReceiver, type WebhookReceiverOptions } from '../receiver.js';

/** The bits of an API Gateway / Lambda Function URL event this adapter touches. */
export interface LambdaLikeEvent {
  headers?: Record<string, string | undefined> | undefined;
  body?: string | null;
  isBase64Encoded?: boolean;
}

/** The response shape API Gateway and Function URLs expect. */
export interface LambdaLikeResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * An AWS Lambda handler for one webhook endpoint — API Gateway (v1 or v2) or a
 * Function URL.
 *
 * ```ts
 * import { createLambdaWebhookHandler } from '@assure/infobip-webhooks/lambda';
 *
 * export const handler = createLambdaWebhookHandler({
 *   kind: 'inbound-message',
 *   authorization: { secret: process.env.INFOBIP_WEBHOOK_SECRET! },
 *   onMessage: async (message) => { await publish(message); },
 * });
 * ```
 *
 * A base64-encoded body is decoded first, which is what you get when the API
 * is configured to treat the content type as binary.
 */
export function createLambdaWebhookHandler(
  options: WebhookReceiverOptions,
): (event: LambdaLikeEvent) => Promise<LambdaLikeResult> {
  const receiver = new WebhookReceiver(options);

  return async (event) => {
    const body = event.isBase64Encoded && event.body ? decodeBase64(event.body) : (event.body ?? '');
    const result = await receiver.handle({ headers: event.headers ?? {}, body });
    return {
      statusCode: result.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result.body),
    };
  };
}

function decodeBase64(value: string): string {
  const nodeBuffer = (globalThis as { Buffer?: { from(v: string, e: string): { toString(e: string): string } } })
    .Buffer;
  if (nodeBuffer) return nodeBuffer.from(value, 'base64').toString('utf8');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
