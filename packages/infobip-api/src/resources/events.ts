import type { components, OutboundEvent, SendEventsRequest, SendMessagesResponse } from '@assure-ai/infobip-types';
import { InfobipConfigError } from '../errors.js';
import { Resource, type RequestOverrides } from './base.js';
import { toRequestInit } from './messages.js';

/** Channels that accept a typing-started event. */
export type TypingStartedChannel = components['schemas']['OutboundTypingStartedEventChannel'];
/** Channels that accept a typing-stopped event. */
export type TypingStoppedChannel = components['schemas']['OutboundTypingStoppedEventChannel'];
/** Channels that accept a seen event. */
export type SeenChannel = components['schemas']['OutboundSeenEventChannel'];

/** Event-level options — platform, validity period, delivery window. */
export type EventOptions = components['schemas']['MessagesApiEventOptions'];

interface EventCommon<TChannel extends string> extends RequestOverrides {
  /**
   * Channel the event applies to.
   *
   * Each event type is supported on its own short list of channels, so this is
   * narrower than the send channels and differs per method.
   */
  channel: TChannel;
  /** The recipient the event is shown to. */
  to: string;
  /** Sender ID registered for the channel. Required on every event. */
  sender: string;
  /** Event options — platform, validity period, delivery window. */
  options?: EventOptions;
}

export interface SendEventsParams extends RequestOverrides {
  /** The events to send, in full spec shape. */
  events: readonly OutboundEvent[];
}

/** A typing-started event. Supported on Apple Messages for Business, RCS, WhatsApp. */
export type TypingStartedParams = EventCommon<TypingStartedChannel>;

/** A typing-stopped event. Supported on Apple Messages for Business only. */
export type TypingStoppedParams = EventCommon<TypingStoppedChannel>;

/** A seen event. Supported on RCS only. */
export interface SeenParams extends EventCommon<SeenChannel> {
  /** The received message being marked as seen. */
  messageId: string;
}

/**
 * Conversation events — `POST /messages-api/1/events`.
 *
 * Typing indicators and read receipts. They carry no content and produce no
 * delivery reports.
 *
 * Channel support is narrow and differs per event: typing-started on Apple
 * Messages for Business, RCS, and WhatsApp; typing-stopped on Apple Messages
 * for Business; seen on RCS. Those limits are in the types, so a channel an
 * event does not support is a compile error rather than a 400.
 */
export class EventsResource extends Resource {
  /** Send one or more events, in full spec shape. */
  async send(params: SendEventsParams): Promise<SendMessagesResponse> {
    const { events, ...overrides } = params;
    if (events.length === 0) {
      throw new InfobipConfigError('`events` must contain at least one event');
    }
    const body: SendEventsRequest = { events: [...events] };
    return this.http.request<SendMessagesResponse>({
      method: 'POST',
      path: 'messages-api/1/events',
      body,
      ...toRequestInit(overrides),
    });
  }

  /** Show the typing indicator. */
  async typingStarted(params: TypingStartedParams): Promise<SendMessagesResponse> {
    const { channel, options, overrides, shared } = split(params);
    const event: components['schemas']['MessagesApiOutboundTypingStartedEvent'] = {
      event: 'TYPING_STARTED',
      channel,
      ...shared,
      ...options,
    };
    return this.send({ events: [event], ...overrides });
  }

  /** Clear the typing indicator. */
  async typingStopped(params: TypingStoppedParams): Promise<SendMessagesResponse> {
    const { channel, options, overrides, shared } = split(params);
    const event: components['schemas']['MessagesApiOutboundTypingStoppedEvent'] = {
      event: 'TYPING_STOPPED',
      channel,
      ...shared,
      ...options,
    };
    return this.send({ events: [event], ...overrides });
  }

  /** Mark a received message as read. */
  async seen(params: SeenParams): Promise<SendMessagesResponse> {
    const { messageId, ...rest } = params;
    const { channel, options, overrides, shared } = split(rest);
    const event: components['schemas']['MessagesApiOutboundSeenEvent'] = {
      event: 'SEEN',
      channel,
      messageId,
      ...shared,
      ...options,
    };
    return this.send({ events: [event], ...overrides });
  }
}

/**
 * Split the common params into the pieces each event literal needs.
 *
 * The three events share every field but `messageId`, yet their types differ in
 * the `channel` literal, so they are built separately and checked separately —
 * a shared builder would need a cast, and a cast here is exactly what would let
 * a wrong shape through.
 */
function split<TChannel extends string>(
  params: EventCommon<TChannel>,
): {
  channel: TChannel;
  shared: { sender: string; destinations: [{ to: string }] };
  options: { options?: EventOptions };
  overrides: RequestOverrides;
} {
  const { channel, to, sender, options, ...overrides } = params;
  return {
    channel,
    shared: { sender, destinations: [{ to }] },
    options: options ? { options } : {},
    overrides,
  };
}
