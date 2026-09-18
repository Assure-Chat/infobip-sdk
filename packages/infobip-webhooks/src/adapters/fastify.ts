import { WebhookReceiver, type WebhookReceiverOptions } from '../receiver.js';

/** The bits of a Fastify request this adapter touches. */
export interface FastifyLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: string | Uint8Array;
}

/** The bits of a Fastify reply this adapter touches. */
export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  send(body: unknown): unknown;
}

/**
 * A Fastify route handler for one webhook endpoint.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { createFastifyWebhookHandler } from '@assure/infobip-webhooks/fastify';
 *
 * const app = Fastify();
 * app.post(
 *   '/webhooks/infobip/seen',
 *   createFastifyWebhookHandler({
 *     kind: 'seen-report',
 *     authorization: { basic: { username: 'infobip', password: process.env.HOOK_PASSWORD! } },
 *     onSeenReports: async (reports) => { await markSeen(reports); },
 *   }),
 * );
 * ```
 *
 * Fastify's JSON parser is fine here — nothing depends on the exact bytes.
 */
export function createFastifyWebhookHandler(
  options: WebhookReceiverOptions,
): (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<void> {
  const receiver = new WebhookReceiver(options);

  return async (request, reply) => {
    const result = await receiver.handle({
      headers: request.headers,
      body: request.rawBody ?? request.body,
    });
    await reply.code(result.status).send(result.body);
  };
}
