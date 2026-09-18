import type { InboundEvent, InboundMessagesResponse, InboundPullChannel } from '@assure/infobip-types';
import { InfobipConfigError } from '../errors.js';
import { Resource, type RequestOverrides } from './base.js';
import { toRequestInit } from './messages.js';
import { assertLimit } from './reports.js';

/** The largest batch the route will return. */
export const MAX_INBOUND_LIMIT = 1000;

export interface FetchInboundParams extends RequestOverrides {
  /**
   * Channel to pull from. Required — unlike the reports queue, there is one
   * inbound queue per channel and no way to read across them.
   */
  channel: InboundPullChannel;
  /** Batch size, 1–1000. The platform defaults to 50. */
  limit?: number;
  /** Restrict to one application. */
  applicationId?: string;
  /** Restrict to one entity, for accounts using entity-level segregation. */
  entityId?: string;
  /** Restrict to one campaign. */
  campaignReferenceId?: string;
  /**
   * Replay this request when it fails with an unknown outcome — a timeout, a
   * socket error, an ambiguous 5xx.
   *
   * Off by default, because the queue is destructive: the replay returns the
   * next batch and the one the failed attempt dequeued is gone.
   *
   * A 429 or 503 is retried regardless — the server refused the request, so
   * nothing was dequeued.
   */
  replayOnUnknownOutcome?: boolean;
}

export interface DrainInboundParams extends Omit<FetchInboundParams, 'limit'> {
  /** Batch size per request, 1–1000. Defaults to the maximum. */
  batchSize?: number;
  /** Stop after this many events. Unbounded when omitted. */
  maxEvents?: number;
  /** Pause between batches, in ms. Default 0. */
  delayMs?: number;
}

/**
 * Inbound messages — `GET /messages-api/1/inbound`.
 *
 * A **destructive pull queue**, with the same semantics as the delivery-report
 * queue: the spec states each request returns a batch "only once", and returns
 * only what has arrived since the last request. So, as there:
 *
 * - {@link fetch} does not retry a failed request by default. A replay after a
 *   timeout returns the *next* batch, and the batch the failed attempt already
 *   dequeued is gone.
 * - One consumer per channel. Two pollers split the stream.
 *
 * Unlike reports, the response carries `pendingMessageCount`, so you can tell
 * how much is still queued without emptying it.
 *
 * Prefer an inbound webhook (see `@assure/infobip-webhooks`). Messages are
 * retained for 48 hours.
 */
export class InboundResource extends Resource {
  /**
   * Fetch the next batch of inbound events, consuming them.
   *
   * ```ts
   * const page = await client.inbound.fetch({ channel: 'WHATSAPP', limit: 100 });
   * console.log(page.results.length, 'received,', page.pendingMessageCount, 'still queued');
   * ```
   */
  async fetch(params: FetchInboundParams): Promise<InboundMessagesResponse> {
    const { channel, limit, applicationId, entityId, campaignReferenceId, replayOnUnknownOutcome, ...overrides } =
      params;
    if (!channel) {
      throw new InfobipConfigError('`channel` is required — inbound queues are per channel');
    }
    assertLimit(limit, MAX_INBOUND_LIMIT);
    return this.http.request<InboundMessagesResponse>({
      method: 'GET',
      path: 'messages-api/1/inbound',
      query: { channel, limit, applicationId, entityId, campaignReferenceId },
      replaySafe: replayOnUnknownOutcome ?? false,
      ...toRequestInit(overrides),
    });
  }

  /**
   * Pull batches until the queue is empty, yielding each event.
   *
   * Stops when `pendingMessageCount` reaches zero, or when a batch comes back
   * empty. Events are consumed as they are yielded — if the loop throws partway
   * through a batch, the rest of that batch is already off the queue.
   *
   * ```ts
   * for await (const event of client.inbound.drain({ channel: 'WHATSAPP' })) {
   *   if (event.event === 'MO') await handle(event);
   * }
   * ```
   */
  async *drain(params: DrainInboundParams): AsyncGenerator<InboundEvent, void, undefined> {
    const { batchSize = MAX_INBOUND_LIMIT, maxEvents, delayMs = 0, ...rest } = params;
    assertLimit(batchSize, MAX_INBOUND_LIMIT);
    if (maxEvents !== undefined && maxEvents <= 0) {
      throw new InfobipConfigError('`maxEvents` must be greater than zero');
    }

    let yielded = 0;
    for (;;) {
      const remaining = maxEvents === undefined ? batchSize : Math.min(batchSize, maxEvents - yielded);
      if (remaining <= 0) return;

      const page = await this.fetch({ ...rest, limit: remaining });
      const results = (page.results ?? []) as InboundEvent[];
      if (results.length === 0) return;

      for (const event of results) {
        yield event;
        yielded += 1;
        if (maxEvents !== undefined && yielded >= maxEvents) return;
      }

      if (page.pendingMessageCount === 0) return;
      if (results.length < remaining) return;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
