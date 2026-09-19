import { describe, expect, it, vi } from 'vitest';
import type { InboundMessageEvent } from '@assure-ai/infobip-types';
import type { WebhookContext } from '../src/index.js';
import { createExpressWebhookHandler } from '../src/adapters/express.js';
import { createFastifyWebhookHandler } from '../src/adapters/fastify.js';
import { createFetchWebhookHandler } from '../src/adapters/fetch.js';
import { createLambdaWebhookHandler } from '../src/adapters/lambda.js';

const payload = {
  results: [{ event: 'MO', channel: 'WHATSAPP', messageId: 'msg-1', content: [{ type: 'TEXT', text: 'hi' }] }],
};
const body = JSON.stringify(payload);
const headers = { 'content-type': 'application/json', 'x-infobip-webhook-secret': 's3cret' };

/** A mock typed as the handler, so the options object typechecks. */
type MessageHandler = (message: InboundMessageEvent, context: WebhookContext) => void;

function messageHandler() {
  return vi.fn<MessageHandler>();
}

function options(onMessage: MessageHandler) {
  return {
    kind: 'inbound-message' as const,
    authorization: { secret: 's3cret' },
    onMessage,
  };
}

describe('express adapter', () => {
  function mockResponse() {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(value: unknown) {
        sent.body = value;
        return value;
      },
    };
    return { res, sent };
  }

  it('handles a body a JSON parser already produced', async () => {
    const onMessage = messageHandler();
    const handler = createExpressWebhookHandler(options(onMessage));
    const { res, sent } = mockResponse();

    await handler({ headers, body: payload }, res, () => {
      throw new Error('next should not be called');
    });

    expect(sent.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('reads the raw stream when no parser ran', async () => {
    const onMessage = messageHandler();
    const handler = createExpressWebhookHandler(options(onMessage));
    const { res, sent } = mockResponse();

    const req = {
      headers,
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(body.slice(0, 10));
        yield new TextEncoder().encode(body.slice(10));
      },
    };

    await handler(req, res, () => {
      throw new Error('next should not be called');
    });

    expect(sent.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('answers 401 without calling the handler when the secret is wrong', async () => {
    const onMessage = messageHandler();
    const handler = createExpressWebhookHandler(options(onMessage));
    const { res, sent } = mockResponse();

    await handler({ headers: { 'content-type': 'application/json' }, body: payload }, res, () => {});

    expect(sent.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('passes an unreadable request to next()', async () => {
    const handler = createExpressWebhookHandler(options(messageHandler()));
    const { res } = mockResponse();
    const next = vi.fn();

    await handler({ headers }, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('fetch adapter', () => {
  it('returns a 200 JSON response for a good delivery', async () => {
    const onMessage = messageHandler();
    const handler = createFetchWebhookHandler(options(onMessage));

    const response = await handler(
      new Request('https://example.test/hooks', { method: 'POST', headers, body }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('refuses a non-POST', async () => {
    const handler = createFetchWebhookHandler(options(messageHandler()));
    const response = await handler(new Request('https://example.test/hooks', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('fastify adapter', () => {
  it('replies with the receiver’s status and body', async () => {
    const onMessage = messageHandler();
    const handler = createFastifyWebhookHandler(options(onMessage));
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        sent.status = status;
        return reply;
      },
      send(value: unknown) {
        sent.body = value;
        return value;
      },
    };

    await handler({ headers, body: payload }, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('prefers rawBody when a plugin captured it', async () => {
    const onMessage = messageHandler();
    const handler = createFastifyWebhookHandler(options(onMessage));
    const reply = { code: () => reply, send: (value: unknown) => value };

    await handler({ headers, body: { ignored: true }, rawBody: body }, reply);
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe('lambda adapter', () => {
  it('returns an API Gateway result', async () => {
    const onMessage = messageHandler();
    const handler = createLambdaWebhookHandler(options(onMessage));

    const result = await handler({ headers, body });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('decodes a base64 body', async () => {
    const onMessage = messageHandler();
    const handler = createLambdaWebhookHandler(options(onMessage));

    const result = await handler({
      headers,
      body: Buffer.from(body, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });

    expect(result.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('answers 400 for a missing body', async () => {
    const handler = createLambdaWebhookHandler(options(messageHandler()));
    const result = await handler({ headers });
    expect(result.statusCode).toBe(400);
  });
});
