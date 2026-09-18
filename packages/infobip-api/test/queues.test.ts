import { describe, expect, it } from 'vitest';
import { InfobipClient, InfobipConfigError, type FetchLike } from '../src/index.js';

const BASE = 'https://xyz1a2.api.infobip.com';

function report(messageId: string): Record<string, unknown> {
  return {
    event: 'DELIVERY',
    channel: 'SMS',
    messageId,
    status: { groupName: 'DELIVERED' },
  };
}

function inboundMessage(messageId: string): Record<string, unknown> {
  return {
    event: 'MO',
    channel: 'WHATSAPP',
    messageId,
    content: [{ type: 'TEXT', text: 'hi' }],
  };
}

/** A fetch that replays scripted JSON responses and records the URLs asked for. */
function scripted(bodies: unknown[]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, urls };
}

function client(fetch: FetchLike): InfobipClient {
  return new InfobipClient({ baseUrl: BASE, apiKey: 'k', fetch });
}

describe('reports.fetch', () => {
  it('passes the documented filters as query parameters', async () => {
    const { fetch, urls } = scripted([{ results: [] }]);
    await client(fetch).reports.fetch({
      channel: 'WHATSAPP',
      bulkId: 'bulk-1',
      messageId: 'msg-1',
      limit: 10,
      entityId: 'entity-1',
      applicationId: 'app-1',
      campaignReferenceId: 'campaign-1',
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/messages-api/1/reports');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      channel: 'WHATSAPP',
      bulkId: 'bulk-1',
      messageId: 'msg-1',
      limit: '10',
      entityId: 'entity-1',
      applicationId: 'app-1',
      campaignReferenceId: 'campaign-1',
    });
  });

  it('omits parameters that were not supplied', async () => {
    const { fetch, urls } = scripted([{ results: [] }]);
    await client(fetch).reports.fetch({ channel: 'SMS' });
    expect(new URL(urls[0]!).search).toBe('?channel=SMS');
  });

  it('rejects a limit the route will not accept, before the request', async () => {
    const { fetch, urls } = scripted([{ results: [] }]);
    await expect(client(fetch).reports.fetch({ limit: 0 })).rejects.toThrow(InfobipConfigError);
    await expect(client(fetch).reports.fetch({ limit: 1001 })).rejects.toThrow(/between 1 and 1000/);
    await expect(client(fetch).reports.fetch({ limit: 1.5 })).rejects.toThrow(InfobipConfigError);
    expect(urls).toHaveLength(0);
  });

  it('does not replay a failed read, because the queue is destructive', async () => {
    let attempts = 0;
    const failing: FetchLike = async () => {
      attempts += 1;
      throw new TypeError('socket hang up');
    };
    await expect(
      new InfobipClient({
        baseUrl: BASE,
        apiKey: 'k',
        fetch: failing,
        retry: { maxRetries: 3, initialDelayMs: 1 },
      }).reports.fetch(),
    ).rejects.toThrow(/failed before a response/);
    expect(attempts).toBe(1);
  });

  it('replays a failed read when the caller opts in', async () => {
    let attempts = 0;
    const failing: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('socket hang up');
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await new InfobipClient({
      baseUrl: BASE,
      apiKey: 'k',
      fetch: failing,
      retry: { maxRetries: 3, initialDelayMs: 1 },
    }).reports.fetch({ replayOnUnknownOutcome: true });
    expect(attempts).toBe(3);
  });
});

describe('reports.drain', () => {
  it('keeps pulling while full batches come back, then stops on a short one', async () => {
    const { fetch, urls } = scripted([
      { results: [report('a'), report('b')] },
      { results: [report('c')] },
    ]);

    const drained: string[] = [];
    for await (const result of client(fetch).reports.drain({ batchSize: 2 })) {
      drained.push(result.messageId!);
    }

    expect(drained).toEqual(['a', 'b', 'c']);
    expect(urls).toHaveLength(2);
  });

  it('stops immediately when the first batch is empty', async () => {
    const { fetch, urls } = scripted([{ results: [] }]);
    const drained = [];
    for await (const result of client(fetch).reports.drain()) drained.push(result);
    expect(drained).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('honours maxReports, and asks for no more than it still needs', async () => {
    const { fetch, urls } = scripted([{ results: [report('a'), report('b'), report('c')] }]);
    const drained: string[] = [];
    for await (const result of client(fetch).reports.drain({ batchSize: 3, maxReports: 2 })) {
      drained.push(result.messageId!);
    }
    expect(drained).toEqual(['a', 'b']);
    expect(new URL(urls[0]!).searchParams.get('limit')).toBe('2');
  });

  it('rejects a maxReports that can never yield anything', async () => {
    const { fetch } = scripted([{ results: [] }]);
    const iterator = client(fetch).reports.drain({ maxReports: 0 });
    await expect(iterator.next()).rejects.toThrow(InfobipConfigError);
  });
});

describe('inbound', () => {
  it('requires a channel, because the queues are per channel', async () => {
    const { fetch, urls } = scripted([{ results: [] }]);
    await expect(
      client(fetch).inbound.fetch({ channel: undefined as never }),
    ).rejects.toThrow(/`channel` is required/);
    expect(urls).toHaveLength(0);
  });

  it('stops draining once nothing is pending, even on a full batch', async () => {
    const { fetch, urls } = scripted([
      { results: [inboundMessage('a'), inboundMessage('b')], pendingMessageCount: 0 },
      { results: [inboundMessage('c')], pendingMessageCount: 0 },
    ]);

    const drained = [];
    for await (const event of client(fetch).inbound.drain({ channel: 'WHATSAPP', batchSize: 2 })) {
      drained.push(event);
    }

    // Two full results with nothing pending: the second request is not made.
    expect(drained).toHaveLength(2);
    expect(urls).toHaveLength(1);
  });

  it('keeps pulling while messages are still pending', async () => {
    const { fetch, urls } = scripted([
      { results: [inboundMessage('a')], pendingMessageCount: 1 },
      { results: [inboundMessage('b')], pendingMessageCount: 0 },
    ]);

    const drained = [];
    for await (const event of client(fetch).inbound.drain({ channel: 'SMS', batchSize: 1 })) {
      drained.push(event);
    }

    expect(drained).toHaveLength(2);
    expect(urls).toHaveLength(2);
  });
});
