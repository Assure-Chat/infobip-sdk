import type { DeliveryReportsResponse, DeliveryResult, ReportChannel } from '@assure-ai/infobip-types';
import { InfobipConfigError } from '../errors.js';
import { Resource, type RequestOverrides } from './base.js';
import { toRequestInit } from './messages.js';

/** The largest batch the route will return. */
export const MAX_REPORT_LIMIT = 1000;

export interface FetchReportsParams extends RequestOverrides {
  /** Restrict to one channel. All channels when omitted. */
  channel?: ReportChannel;
  /** Restrict to one bulk — the id a send returned. */
  bulkId?: string;
  /** Restrict to one message. */
  messageId?: string;
  /** Batch size, 1–1000. The platform defaults to 50. */
  limit?: number;
  /** Restrict to one entity, for accounts using entity-level segregation. */
  entityId?: string;
  /** Restrict to one application. */
  applicationId?: string;
  /** Restrict to one campaign. */
  campaignReferenceId?: string;
  /**
   * Replay this request when it fails with an unknown outcome — a timeout, a
   * socket error, an ambiguous 5xx.
   *
   * Off by default, because the queue is destructive: the replay returns the
   * next batch and the one the failed attempt dequeued is gone. Turn it on only
   * where losing a batch is acceptable.
   *
   * A 429 or 503 is retried regardless — the server refused the request, so
   * nothing was dequeued.
   */
  replayOnUnknownOutcome?: boolean;
}

export interface DrainReportsParams extends Omit<FetchReportsParams, 'limit'> {
  /** Batch size per request, 1–1000. Defaults to the maximum. */
  batchSize?: number;
  /** Stop after this many reports. Unbounded when omitted. */
  maxReports?: number;
  /** Pause between batches, in ms. Default 0. */
  delayMs?: number;
}

/**
 * Delivery reports — `GET /messages-api/1/reports`.
 *
 * This is a **destructive pull queue**, not a query. The spec is explicit that
 * reports "will be returned only once": each call hands back the next batch and
 * the platform will not hand those records out again. Two consequences the type
 * signatures cannot express on their own:
 *
 * - **Replaying a failed call can lose data.** If a request times out after the
 *   platform has already dequeued a batch, the replay returns the *next* batch
 *   and the first one is gone. So {@link fetch} does not replay on an unknown
 *   outcome, even though it is a GET. Opt in per call with
 *   `replayOnUnknownOutcome` when a lost batch is acceptable. A 429 or 503 is
 *   still retried: the server refused the request, so nothing was dequeued.
 * - **Only one consumer per account can poll.** Two pollers split the stream
 *   between them, each seeing an arbitrary half.
 *
 * Prefer a delivery-report webhook (see `@assure-ai/infobip-webhooks`); this route
 * exists for when you cannot expose one. Reports are retained for 48 hours.
 */
export class ReportsResource extends Resource {
  /**
   * Fetch the next batch of delivery reports, consuming them.
   *
   * ```ts
   * const { results } = await client.reports.fetch({ channel: 'WHATSAPP', limit: 100 });
   * ```
   */
  async fetch(params: FetchReportsParams = {}): Promise<DeliveryReportsResponse> {
    const { channel, bulkId, messageId, limit, entityId, applicationId, campaignReferenceId, replayOnUnknownOutcome, ...overrides } =
      params;
    assertLimit(limit);
    return this.http.request<DeliveryReportsResponse>({
      method: 'GET',
      path: 'messages-api/1/reports',
      query: {
        channel,
        bulkId,
        messageId,
        limit,
        entityId,
        applicationId,
        campaignReferenceId,
      },
      replaySafe: replayOnUnknownOutcome ?? false,
      ...toRequestInit(overrides),
    });
  }

  /**
   * Pull batches until the queue is empty, yielding each report.
   *
   * The queue has no cursor and no total, so "empty" means a batch came back
   * with no results. Anything that arrives after that point waits for the next
   * drain.
   *
   * ```ts
   * for await (const report of client.reports.drain({ channel: 'SMS' })) {
   *   await record(report.messageId, report.status?.groupName);
   * }
   * ```
   *
   * Reports are consumed as they are yielded: if the loop throws partway
   * through a batch, the rest of that batch is already off the queue. Handle
   * failures inside the loop rather than around it.
   */
  async *drain(params: DrainReportsParams = {}): AsyncGenerator<DeliveryResult, void, undefined> {
    const { batchSize = MAX_REPORT_LIMIT, maxReports, delayMs = 0, ...rest } = params;
    assertLimit(batchSize);
    if (maxReports !== undefined && maxReports <= 0) {
      throw new InfobipConfigError('`maxReports` must be greater than zero');
    }

    let yielded = 0;
    for (;;) {
      const remaining = maxReports === undefined ? batchSize : Math.min(batchSize, maxReports - yielded);
      if (remaining <= 0) return;

      const page = await this.fetch({ ...rest, limit: remaining });
      const results = page.results ?? [];
      if (results.length === 0) return;

      for (const report of results) {
        yield report;
        yielded += 1;
        if (maxReports !== undefined && yielded >= maxReports) return;
      }

      // A short batch means the queue had nothing more to give.
      if (results.length < remaining) return;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

/** @internal */
export function assertLimit(limit: number | undefined, max = MAX_REPORT_LIMIT): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new InfobipConfigError(`\`limit\` must be an integer between 1 and ${max}, got ${limit}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
