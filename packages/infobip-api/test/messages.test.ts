import { describe, expect, it } from 'vitest';
import {
  InfobipClient,
  InfobipConfigError,
  InfobipRateLimitError,
  InfobipValidationError,
  type FetchLike,
} from '../src/index.js';

const BASE = 'https://xyz1a2.api.infobip.com';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records every call and replays scripted responses. */
function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(scripted?.body === undefined ? '' : JSON.stringify(scripted.body), {
      status: scripted?.status ?? 200,
      headers: { 'content-type': 'application/json', ...(scripted?.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const ACCEPTED = {
  bulkId: 'bulk-1',
  messages: [{ messageId: 'msg-1', status: { groupName: 'PENDING' }, destination: '441134960001' }],
};

function client(fetch: FetchLike, options: Record<string, unknown> = {}): InfobipClient {
  return new InfobipClient({ baseUrl: BASE, apiKey: 'test-key', fetch, ...options });
}

describe('messages.sendText', () => {
  it('builds the documented request shape', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ACCEPTED }]);
    const response = await client(fetch).messages.sendText({
      channel: 'WHATSAPP',
      sender: '441134960000',
      to: '441134960001',
      text: 'Your code is 114233.',
    });

    expect(response.bulkId).toBe('bulk-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/messages-api/1/messages`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['authorization']).toBe('App test-key');
    expect(calls[0]?.body).toEqual({
      messages: [
        {
          channel: 'WHATSAPP',
          sender: '441134960000',
          destinations: [{ to: '441134960001' }],
          content: { body: { type: 'TEXT', text: 'Your code is 114233.' } },
        },
      ],
    });
  });

  it('fans one text out to several destinations in one bulk', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ACCEPTED }]);
    await client(fetch).messages.sendText({
      channel: 'SMS',
      to: ['441134960001', '441134960002'],
      text: 'hello',
    });

    const body = calls[0]?.body as { messages: Array<{ destinations: unknown[] }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.destinations).toEqual([{ to: '441134960001' }, { to: '441134960002' }]);
  });

  it('refuses one messageId across several destinations', async () => {
    const { fetch } = mockFetch([{ status: 200, body: ACCEPTED }]);
    await expect(
      client(fetch).messages.sendText({
        channel: 'SMS',
        to: ['441134960001', '441134960002'],
        messageId: 'shared',
        text: 'hello',
      }),
    ).rejects.toThrow(InfobipConfigError);
  });

  it('rejects an empty message list before making a request', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ACCEPTED }]);
    await expect(client(fetch).messages.send({ messages: [] })).rejects.toThrow(InfobipConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe('messages.sendAuthenticationRequest', () => {
  it('sends an AUTHENTICATION_REQUEST body with its scopes', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ACCEPTED }]);
    await client(fetch).messages.sendAuthenticationRequest({
      channel: 'APPLE_MB',
      sender: 'northline-bank',
      to: 'urn:mbid:example',
      text: 'Confirm it is you',
      scopes: ['openid', 'email'],
    });

    const body = calls[0]?.body as { messages: Array<{ content: { body: unknown } }> };
    expect(body.messages[0]?.content.body).toEqual({
      type: 'AUTHENTICATION_REQUEST',
      text: 'Confirm it is you',
      scopes: ['openid', 'email'],
    });
  });
});

describe('messages.validate', () => {
  it('returns a 400 as a result rather than throwing', async () => {
    const { fetch } = mockFetch([
      {
        status: 400,
        body: {
          description: 'Invalid message',
          action: 'Fix the message',
          violations: [{ property: 'messages[0].content.body.text', violation: 'must not be blank' }],
        },
      },
    ]);

    const result = await client(fetch).messages.validate({
      messages: [
        {
          channel: 'SMS',
          destinations: [{ to: '441134960001' }],
          content: { body: { type: 'TEXT', text: '' } },
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.violations).toHaveLength(1);
      expect(result.description).toBe('Invalid message');
    }
  });

  it('reports a valid payload, with any skippable violations', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          description: 'Message is valid',
          action: 'No action needed',
          skippableViolations: [{ property: 'messages[0].sender', violation: 'unregistered sender' }],
        },
      },
    ]);

    const result = await client(fetch).messages.validate({
      messages: [
        {
          channel: 'SMS',
          destinations: [{ to: '441134960001' }],
          content: { body: { type: 'TEXT', text: 'hi' } },
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.skippableViolations).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/messages-api/1/messages/validate`);
  });

  it('still throws on a 401 from the validate route', async () => {
    const { fetch } = mockFetch([{ status: 401 }]);
    await expect(
      client(fetch, { retry: { maxRetries: 0 } }).messages.validate({
        messages: [
          {
            channel: 'SMS',
            destinations: [{ to: '441134960001' }],
            content: { body: { type: 'TEXT', text: 'hi' } },
          },
        ],
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('error mapping', () => {
  const message = {
    channel: 'SMS' as const,
    destinations: [{ to: '441134960001' }],
    content: { body: { type: 'TEXT' as const, text: 'hi' } },
  };

  it('maps a 400 to a validation error carrying the violations', async () => {
    const { fetch } = mockFetch([
      {
        status: 400,
        body: {
          errorCode: 'BAD_REQUEST',
          description: 'Something is wrong',
          action: 'Fix it',
          violations: [{ property: 'messages[0].channel', violation: 'unsupported' }],
        },
      },
    ]);

    const error = await client(fetch)
      .messages.send({ messages: [message] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InfobipValidationError);
    expect((error as InfobipValidationError).code).toBe('BAD_REQUEST');
    expect((error as InfobipValidationError).action).toBe('Fix it');
    expect((error as InfobipValidationError).violations).toHaveLength(1);
  });

  it('understands the platform’s legacy requestError envelope', async () => {
    const { fetch } = mockFetch([
      {
        status: 403,
        body: {
          requestError: {
            serviceException: { messageId: 'UNAUTHORIZED', text: 'Invalid login details' },
          },
        },
      },
    ]);

    const error = await client(fetch)
      .messages.send({ messages: [message] })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('Invalid login details');
    expect((error as InfobipValidationError).code).toBe('UNAUTHORIZED');
  });

  it('falls back to the status when the body is not an error envelope', async () => {
    const { fetch } = mockFetch([{ status: 502, body: { nothing: 'useful' } }]);
    const error = await client(fetch, { retry: { maxRetries: 0 } })
      .messages.send({ messages: [message] })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('HTTP 502');
  });

  it('reads Retry-After in seconds off a 429', async () => {
    const { fetch } = mockFetch([{ status: 429, headers: { 'retry-after': '2' } }]);
    const error = await client(fetch, { retry: { maxRetries: 0 } })
      .messages.send({ messages: [message] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InfobipRateLimitError);
    expect((error as InfobipRateLimitError).retryAfterMs).toBe(2000);
  });
});

describe('retries', () => {
  const message = {
    channel: 'SMS' as const,
    destinations: [{ to: '441134960001' }],
    content: { body: { type: 'TEXT' as const, text: 'hi' } },
  };

  it('retries a send after a 429 — the server refused it, so nothing was sent', async () => {
    const { fetch, calls } = mockFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: ACCEPTED },
    ]);
    const response = await client(fetch, {
      retry: { maxRetries: 2, initialDelayMs: 1 },
    }).messages.send({ messages: [message] });

    expect(response.bulkId).toBe('bulk-1');
    expect(calls).toHaveLength(2);
  });

  it('retries a send after a 503', async () => {
    const { fetch, calls } = mockFetch([{ status: 503 }, { status: 200, body: ACCEPTED }]);
    await client(fetch, { retry: { maxRetries: 2, initialDelayMs: 1 } }).messages.send({
      messages: [message],
    });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a send after a 500 — it may already have been delivered', async () => {
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 200, body: ACCEPTED }]);
    await expect(
      client(fetch, { retry: { maxRetries: 2, initialDelayMs: 1 } }).messages.send({
        messages: [message],
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it('does not replay a send whose request never got a response', async () => {
    let attempts = 0;
    const failing: FetchLike = async () => {
      attempts += 1;
      throw new TypeError('socket hang up');
    };
    await expect(
      client(failing, { retry: { maxRetries: 3, initialDelayMs: 1 } }).messages.send({
        messages: [message],
      }),
    ).rejects.toThrow(/failed before a response/);
    expect(attempts).toBe(1);
  });

  it('does not retry a 400', async () => {
    const { fetch, calls } = mockFetch([{ status: 400, body: { description: 'nope' } }]);
    await expect(
      client(fetch, { retry: { maxRetries: 2, initialDelayMs: 1 } }).messages.send({
        messages: [message],
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('re-derives the credential and retries once after a 401', async () => {
    let mints = 0;
    const { fetch, calls } = mockFetch([{ status: 401 }, { status: 200, body: ACCEPTED }]);
    const scoped = new InfobipClient({
      baseUrl: BASE,
      fetch,
      retry: { maxRetries: 0 },
      getCredential: async () => {
        mints += 1;
        return { token: `token-${mints}`, expiresAt: Date.now() + 600_000 };
      },
    });

    await scoped.messages.send({ messages: [message] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['authorization']).toBe('Bearer token-1');
    expect(calls[1]?.headers['authorization']).toBe('Bearer token-2');
  });
});
