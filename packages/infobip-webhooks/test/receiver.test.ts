import { describe, expect, it, vi } from 'vitest';
import { WebhookReceiver, detectKind, timingSafeEqual } from '../src/index.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

const deliveryPayload = {
  results: [
    { event: 'DELIVERY', channel: 'SMS', messageId: 'msg-1', status: { groupName: 'DELIVERED' } },
  ],
};

const seenPayload = {
  results: [{ event: 'SEEN', channel: 'RCS', messageId: 'msg-1', seenAt: '2026-09-18T10:00:00.000+0000' }],
};

const inboundPayload = {
  results: [
    { event: 'MO', channel: 'WHATSAPP', messageId: 'msg-1', content: [{ type: 'TEXT', text: 'hi' }] },
    { event: 'TYPING_STARTED', channel: 'WHATSAPP' },
  ],
};

describe('authorization', () => {
  it('rejects a delivery with no secret header', async () => {
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { secret: 's3cret' },
    });
    const result = await receiver.handle({
      headers: JSON_HEADERS,
      body: JSON.stringify(deliveryPayload),
    });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('rejects a wrong secret', async () => {
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { secret: 's3cret' },
    });
    const result = await receiver.handle({
      headers: { ...JSON_HEADERS, 'x-infobip-webhook-secret': 'wrong' },
      body: JSON.stringify(deliveryPayload),
    });
    expect(result.status).toBe(401);
  });

  it('accepts the configured secret, on a custom header name', async () => {
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { secret: 's3cret', header: 'x-my-hook' },
      onDeliveryReports,
    });
    const result = await receiver.handle({
      headers: { ...JSON_HEADERS, 'X-My-Hook': 's3cret' },
      body: JSON.stringify(deliveryPayload),
    });

    expect(result.status).toBe(200);
    expect(onDeliveryReports).toHaveBeenCalledOnce();
  });

  it('checks basic credentials', async () => {
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { basic: { username: 'Aladdin', password: 'openSesame' } },
    });

    const good = await receiver.handle({
      headers: { ...JSON_HEADERS, authorization: 'Basic QWxhZGRpbjpvcGVuU2VzYW1l' },
      body: JSON.stringify(deliveryPayload),
    });
    expect(good.status).toBe(200);

    const bad = await receiver.handle({
      headers: { ...JSON_HEADERS, authorization: 'Basic d3Jvbmc6d3Jvbmc=' },
      body: JSON.stringify(deliveryPayload),
    });
    expect(bad.status).toBe(401);
  });

  it('rejects a non-Basic Authorization header under the basic scheme', async () => {
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { basic: { username: 'a', password: 'b' } },
    });
    const result = await receiver.handle({
      headers: { ...JSON_HEADERS, authorization: 'Bearer token' },
      body: JSON.stringify(deliveryPayload),
    });
    expect(result.status).toBe(401);
  });

  it('runs a custom check and can reject on it', async () => {
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: { custom: ({ headers }) => (headers as Record<string, string>)['x-ok'] === 'yes' },
    });

    const denied = await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(deliveryPayload) });
    expect(denied.status).toBe(401);

    const allowed = await receiver.handle({
      headers: { ...JSON_HEADERS, 'x-ok': 'yes' },
      body: JSON.stringify(deliveryPayload),
    });
    expect(allowed.status).toBe(200);
  });

  it('accepts everything under `none`', async () => {
    const receiver = new WebhookReceiver({ kind: 'delivery-report', authorization: 'none' });
    const result = await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(deliveryPayload) });
    expect(result.status).toBe(200);
  });
});

describe('parsing', () => {
  const open = { kind: 'delivery-report', authorization: 'none' } as const;

  it('rejects a body that is not JSON', async () => {
    const receiver = new WebhookReceiver(open);
    const result = await receiver.handle({ headers: JSON_HEADERS, body: 'not json' });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'malformed_json' });
  });

  it('rejects an empty body', async () => {
    const receiver = new WebhookReceiver(open);
    const result = await receiver.handle({ headers: JSON_HEADERS, body: '' });
    expect(result.body).toMatchObject({ code: 'unexpected_payload' });
  });

  it('rejects a payload with no results array', async () => {
    const receiver = new WebhookReceiver(open);
    const result = await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify({ ok: 1 }) });
    expect(result.body).toMatchObject({ code: 'unexpected_payload' });
  });

  it('explains an XML delivery report rather than failing on the parse', async () => {
    const receiver = new WebhookReceiver(open);
    const result = await receiver.handle({
      headers: { 'content-type': 'application/xml' },
      body: '<results/>',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'unsupported_content_type' });
    expect((result.body as { error: string }).error).toMatch(/webhooks.contentType/);
  });

  it('accepts a body a JSON middleware already parsed', async () => {
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({ ...open, onDeliveryReports });
    const result = await receiver.handle({ headers: JSON_HEADERS, body: deliveryPayload });
    expect(result.status).toBe(200);
    expect(onDeliveryReports).toHaveBeenCalledOnce();
  });

  it('accepts a body handed over as bytes', async () => {
    const receiver = new WebhookReceiver(open);
    const body = new TextEncoder().encode(JSON.stringify(deliveryPayload));
    expect((await receiver.handle({ headers: JSON_HEADERS, body })).status).toBe(200);
  });

  it('accepts a Headers instance', async () => {
    const receiver = new WebhookReceiver({ kind: 'delivery-report', authorization: { secret: 's' } });
    const headers = new Headers({ 'content-type': 'application/json', 'x-infobip-webhook-secret': 's' });
    expect(
      (await receiver.handle({ headers, body: JSON.stringify(deliveryPayload) })).status,
    ).toBe(200);
  });
});

describe('dispatch', () => {
  it('routes a seen report to its own handler', async () => {
    const onSeenReports = vi.fn();
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'seen-report',
      authorization: 'none',
      onSeenReports,
      onDeliveryReports,
    });

    await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(seenPayload) });
    expect(onSeenReports).toHaveBeenCalledOnce();
    expect(onDeliveryReports).not.toHaveBeenCalled();
  });

  it('calls onMessage for received messages only, and onInboundEvents for all', async () => {
    const onMessage = vi.fn();
    const onInboundEvents = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'inbound-message',
      authorization: 'none',
      onMessage,
      onInboundEvents,
    });

    await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(inboundPayload) });
    expect(onInboundEvents).toHaveBeenCalledOnce();
    expect(onInboundEvents.mock.calls[0]?.[0]).toHaveLength(2);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ event: 'MO', messageId: 'msg-1' });
  });

  it('reports an accepted delivery no handler covered', async () => {
    const onUnhandled = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: 'none',
      onUnhandled,
    });

    const result = await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(deliveryPayload) });
    expect(result.status).toBe(200);
    expect(onUnhandled).toHaveBeenCalledOnce();
  });

  it('answers 500 when a handler throws, so the platform retries', async () => {
    const onError = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: 'none',
      onDeliveryReports: () => {
        throw new Error('database down');
      },
      onError,
    });

    const result = await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(deliveryPayload) });
    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toBe('database down');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('passes the kind and raw body through to the handler context', async () => {
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: 'none',
      onDeliveryReports,
    });
    const body = JSON.stringify(deliveryPayload);

    await receiver.handle({ headers: JSON_HEADERS, body });
    expect(onDeliveryReports.mock.calls[0]?.[1]).toMatchObject({
      kind: 'delivery-report',
      rawBody: body,
    });
  });
});

describe('deduplication', () => {
  it('acknowledges a repeat delivery without running the handler again', async () => {
    const seenKeys = new Set<string>();
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: 'none',
      onDeliveryReports,
      deduplicate: {
        seen: (key) => {
          if (seenKeys.has(key)) return true;
          seenKeys.add(key);
          return false;
        },
      },
    });

    const body = JSON.stringify(deliveryPayload);
    const first = await receiver.handle({ headers: JSON_HEADERS, body });
    const second = await receiver.handle({ headers: JSON_HEADERS, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(onDeliveryReports).toHaveBeenCalledOnce();
  });

  it('keys on the whole batch, so a different batch is not suppressed', async () => {
    const seenKeys = new Set<string>();
    const onDeliveryReports = vi.fn();
    const receiver = new WebhookReceiver({
      kind: 'delivery-report',
      authorization: 'none',
      onDeliveryReports,
      deduplicate: {
        seen: (key) => {
          if (seenKeys.has(key)) return true;
          seenKeys.add(key);
          return false;
        },
      },
    });

    await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(deliveryPayload) });
    await receiver.handle({
      headers: JSON_HEADERS,
      body: JSON.stringify({ results: [{ event: 'DELIVERY', messageId: 'msg-2' }] }),
    });

    expect(onDeliveryReports).toHaveBeenCalledTimes(2);
  });
});

describe('detectKind', () => {
  it('reads the event discriminator', () => {
    expect(detectKind(deliveryPayload)).toBe('delivery-report');
    expect(detectKind(seenPayload)).toBe('seen-report');
    expect(detectKind(inboundPayload)).toBe('inbound-message');
  });

  it('falls back to shape when the defaulted event field is missing', () => {
    expect(detectKind({ results: [{ seenAt: '2026-09-18T10:00:00Z' }] })).toBe('seen-report');
    expect(detectKind({ results: [{ doneAt: '2026-09-18T10:00:00Z' }] })).toBe('delivery-report');
    expect(detectKind({ results: [{ content: [] }] })).toBe('inbound-message');
  });

  it('returns undefined rather than guessing', () => {
    expect(detectKind({ results: [] })).toBeUndefined();
    expect(detectKind({ results: [{ messageId: 'x' }] })).toBeUndefined();
    expect(detectKind(null)).toBeUndefined();
  });

  it('rejects a delivery it cannot classify under auto', async () => {
    const receiver = new WebhookReceiver({ kind: 'auto', authorization: 'none' });
    const result = await receiver.handle({
      headers: JSON_HEADERS,
      body: JSON.stringify({ results: [{ messageId: 'x' }] }),
    });
    expect(result.body).toMatchObject({ code: 'unknown_kind' });
  });

  it('routes correctly under auto', async () => {
    const onSeenReports = vi.fn();
    const receiver = new WebhookReceiver({ kind: 'auto', authorization: 'none', onSeenReports });
    await receiver.handle({ headers: JSON_HEADERS, body: JSON.stringify(seenPayload) });
    expect(onSeenReports).toHaveBeenCalledOnce();
  });
});

describe('timingSafeEqual', () => {
  it('matches equal strings and rejects differences', () => {
    expect(timingSafeEqual('secret', 'secret')).toBe(true);
    expect(timingSafeEqual('secret', 'secrer')).toBe(false);
    expect(timingSafeEqual('secret', 'secret-longer')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('compares bytes, not code units', () => {
    expect(timingSafeEqual('é', 'é')).toBe(true);
    expect(timingSafeEqual('é', 'e')).toBe(false);
  });
});
