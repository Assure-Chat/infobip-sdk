import { WebhookReceiver, type WebhookReceiverOptions } from '../receiver.js';

/** The bits of an Express/Connect request this adapter touches. */
export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
}

/** The bits of an Express response this adapter touches. */
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}

export type ExpressLikeNext = (error?: unknown) => void;

/**
 * An Express (or Connect) handler for one webhook endpoint.
 *
 * ```ts
 * import express from 'express';
 * import { createExpressWebhookHandler } from '@assure-ai/infobip-webhooks/express';
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.post(
 *   '/webhooks/infobip/inbound',
 *   createExpressWebhookHandler({
 *     kind: 'inbound-message',
 *     authorization: { secret: process.env.INFOBIP_WEBHOOK_SECRET! },
 *     onMessage: async (message) => { await enqueue(message); },
 *   }),
 * );
 * ```
 *
 * Unlike a signed webhook, nothing here depends on the exact request bytes, so
 * `express.json()` upstream is fine — a parsed body is re-serialized. Register
 * one handler per endpoint, each with the `kind` that endpoint receives.
 */
export function createExpressWebhookHandler(
  options: WebhookReceiverOptions,
): (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressLikeNext) => Promise<void> {
  const receiver = new WebhookReceiver(options);

  return async (req, res, next) => {
    try {
      const body = await readBody(req);
      const result = await receiver.handle({ headers: req.headers, body });
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  };
}

async function readBody(req: ExpressLikeRequest): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) return req.body;

  if (typeof req[Symbol.asyncIterator] !== 'function') {
    throw new Error('Request body is not readable — no parsed body and no readable stream');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
