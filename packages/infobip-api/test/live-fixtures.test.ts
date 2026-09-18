import { describe, expect, it } from 'vitest';
import { InfobipApiError, InfobipAuthenticationError, InfobipClient, type FetchLike } from '../src/index.js';

/**
 * Responses captured from a real account host, not written by hand.
 *
 * They exist because the spec and the running service disagree in small ways
 * that only traffic reveals — the 401 below is documented as having no content,
 * and does not.
 */

/** Verbatim body of an unauthenticated POST /messages-api/1/messages. */
const LIVE_401 = {
  errorCode: 'E401',
  description: 'The request lacks valid authentication credentials for the requested resource.',
  action: 'Check the resources and adjust authentication credentials.',
  violations: [],
  resources: [
    { name: 'API Authentication', url: 'https://www.infobip.com/docs/api/essentials/api-authentication' },
    { name: 'API endpoint documentation', url: 'https://www.infobip.com/docs/api/send-messages-api-message' },
  ],
};

function respondWith(status: number, body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('live response fixtures', () => {
  const message = {
    channel: 'RCS' as const,
    sender: 'assure_agent',
    destinations: [{ to: '441134960001' }],
    content: { body: { type: 'TEXT' as const, text: 'hi' } },
  };

  it('reads the real 401 envelope the spec says is empty', async () => {
    const client = new InfobipClient({
      baseUrl: 'https://xxxxx.api.infobip.com',
      apiKey: 'wrong',
      fetch: respondWith(401, LIVE_401),
      retry: { maxRetries: 0 },
    });

    const error = await client.messages
      .send({ messages: [message] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InfobipAuthenticationError);
    const api = error as InfobipApiError;
    expect(api.status).toBe(401);
    expect(api.code).toBe('E401');
    expect(api.action).toBe('Check the resources and adjust authentication credentials.');
    expect(api.message).toContain('lacks valid authentication credentials');
    // The full body stays reachable — `resources` is not modelled on the error
    // class, and it carries the documentation links worth showing a caller.
    expect(api.body).toEqual(LIVE_401);
  });

  it('re-derives the credential only once on a persistent 401', async () => {
    let attempts = 0;
    const client = new InfobipClient({
      baseUrl: 'https://xxxxx.api.infobip.com',
      retry: { maxRetries: 0 },
      getCredential: async () => `token-${(attempts += 1)}`,
      fetch: respondWith(401, LIVE_401),
    });

    await expect(client.messages.send({ messages: [message] })).rejects.toThrow(/401/);
    // One initial derive plus one re-derive; not a loop.
    expect(attempts).toBe(2);
  });
});
