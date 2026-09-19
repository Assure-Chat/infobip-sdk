import { WebhookReceiver, type WebhookReceiverOptions } from '../receiver.js';

/**
 * A standard `Request` → `Response` handler, for any runtime whose HTTP layer
 * speaks Fetch: Cloudflare Workers, Deno, Bun, Next.js route handlers, Hono.
 *
 * ```ts
 * import { createFetchWebhookHandler } from '@assure-ai/infobip-webhooks/fetch';
 *
 * const handler = createFetchWebhookHandler({
 *   kind: 'delivery-report',
 *   authorization: { secret: env.INFOBIP_WEBHOOK_SECRET },
 *   onDeliveryReports: async (reports) => { await record(reports); },
 * });
 *
 * export default { fetch: handler };
 * ```
 */
export function createFetchWebhookHandler(
  options: WebhookReceiverOptions,
): (request: Request) => Promise<Response> {
  const receiver = new WebhookReceiver(options);

  return async (request) => {
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });
    }
    const body = await request.text();
    const result = await receiver.handle({ headers: request.headers, body });
    return jsonResponse(result.status, result.body);
  };
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}
