/**
 * `@assure/infobip-types` — the Infobip Messages API, as TypeScript.
 *
 * Three layers, in increasing order of how much a human touched them:
 *
 * 1. `./openapi` — verbatim `openapi-typescript` output. Every schema, under
 *    `components['schemas'][…]`. Regenerated from the spec; never edited.
 * 2. The `…Union` aliases — derived from the spec's own `discriminator.mapping`
 *    entries, because the generator leaves a polymorphic base as the open
 *    parent type and it narrows to nothing. Also generated.
 * 3. This file — short names for the types you actually reach for, plus the
 *    channel and status vocabularies as runtime values.
 */
import type { components } from './openapi.js';
import type {
  MessagesApiInboundEventUnion,
  MessagesApiMessageBodyUnion,
  MessagesApiMessageButtonUnion,
  MessagesApiMoEventContentUnion,
  MessagesApiOutboundEventUnion,
} from './unions.js';

export type { components, operations, paths, webhooks } from './openapi.js';
export type * from './unions.js';

type Schemas = components['schemas'];

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Body of `POST /messages-api/1/messages` — one or more messages in one bulk. */
export type SendMessagesRequest = Schemas['MessagesApiRequest'];

/**
 * A single outbound message: channel, destinations, and content.
 *
 * `content` is the curated {@link MessageContent}, not the generated one, so
 * the body narrows — see the note there.
 */
export interface OutboundMessage extends Omit<Schemas['MessagesApiMessage'], 'content'> {
  content: MessageContent;
}

/** A single outbound message rendered from a pre-registered template. */
export type OutboundTemplateMessage = Schemas['MessagesApiTemplateMessage'];

/** Either message shape — what `SendMessagesRequest.messages` actually holds. */
export type AnyOutboundMessage = OutboundMessage | OutboundTemplateMessage;

/** Where a message goes. Either a plain `to`, or per-channel substitutes. */
export type MessageDestination = Schemas['MessageDestination'];

/**
 * Message content: header, body, buttons, footer.
 *
 * `body` and `buttons` are replaced with their unions. The generated schema
 * points both at the open parent — `{ type: MessageBodyType }` — which accepts
 * a discriminator and nothing else, so `{ type: 'TEXT', text: 'hi' }` would not
 * compile against it. Swapping in the unions is what makes a message literal
 * writable and makes `switch (body.type)` narrow.
 */
export interface MessageContent
  extends Omit<Schemas['MessagesApiMessageContent'], 'body' | 'buttons'> {
  body: MessageBody;
  buttons?: MessageButton[];
}

/**
 * The message body, as a union that narrows on `type`.
 *
 * ```ts
 * if (body.type === 'TEXT') body.text;           // string
 * if (body.type === 'IMAGE') body.url;           // string
 * ```
 */
export type MessageBody = MessagesApiMessageBodyUnion;

/** A button on a message, narrowing on `type`. */
export type MessageButton = MessagesApiMessageButtonUnion;

/** Per-message options: scheduling, validity, tracking, traffic type. */
export type MessageOptions = Schemas['MessagesApiMessageOptions'];

/** Options applied to every message in one request. */
export type RequestOptions = Schemas['MessagesApiRequestOptions'];

/** Per-message webhook configuration — where reports for it are delivered. */
export type MessageWebhooks = Schemas['MessagesApiWebhooks'];

/** Body of `POST /messages-api/1/events`. */
export type SendEventsRequest = Schemas['MessagesApiEventRequest'];

/** An outbound event — typing indicators and read receipts, narrowing on `event`. */
export type OutboundEvent = MessagesApiOutboundEventUnion;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Response to a send: the bulk id and one entry per message. */
export type SendMessagesResponse = Schemas['ResponseEnvelopeMessageResponseMessageResponseDetails'];

/** One message's acceptance status within a send response. */
export type MessageResponse = Schemas['MessageResponseMessageResponseDetails'];

/** Status of a single message in a send response — group, code, and recovery. */
export type MessageStatus = Schemas['MessageStatus'];

/**
 * Status of a message in a *delivery report*.
 *
 * Carries the same vocabulary as {@link MessageStatus} but is a separate schema
 * upstream, and its `groupName` is declared as a bare `string` rather than the
 * enum — so the guards below take `string` and narrow, rather than making every
 * caller cast between two spellings of the same idea.
 */
export type DeliveryStatus = Schemas['MessagesApiDeliveryStatus'];

/** `POST /messages/validate` when the payload is valid. */
export type ValidationOkResponse = Schemas['ValidationOkResponse'];

/** `POST /messages/validate` when it is not. Carries the violations. */
export type ValidationBadResponse = Schemas['ValidationBadResponse'];

/** One field-level complaint from validation or an error envelope. */
export type ApiErrorViolation = Schemas['ApiErrorViolation'];

/** The platform's error envelope. */
export type ApiError = Schemas['ApiError'];

/** `GET /messages-api/1/reports`. */
export type DeliveryReportsResponse = Schemas['MessagesApiDeliveryReportResponse'];

/** One delivery report. */
export type DeliveryResult = Schemas['MessagesApiDeliveryResult'];

/** `GET /messages-api/1/inbound`, including the pending-message counter. */
export type InboundMessagesResponse = Schemas['MessagesApiIncomingMessageResponse'];

/** An inbound event — a received message, or a typing indicator. */
export type InboundEvent = MessagesApiInboundEventUnion;

/**
 * A received message (`event: 'MO'`).
 *
 * `content` is the curated union, for the same reason as {@link MessageContent}:
 * the generated schema points at the open parent, which narrows to nothing.
 */
export interface InboundMessageEvent extends Omit<Schemas['MessagesApiMoEvent'], 'content'> {
  content: InboundContent[];
}

/** One content part of a received message, narrowing on `type`. */
export type InboundContent = MessagesApiMoEventContentUnion;

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

/** Body pushed to a configured delivery-report webhook. */
export type DeliveryReportWebhookPayload = Schemas['MessagesApiDeliveryReportResponse'];

/** Body pushed to a configured seen-report webhook. */
export type SeenReportWebhookPayload = Schemas['MessagesApiSeenReport'];

/** One seen report. */
export type SeenResult = Schemas['MessagesApiSeenResult'];

/** Body pushed to a configured inbound-message webhook. */
export type InboundMessageWebhookPayload = Schemas['MessagesApiIncomingMessage'];

// ---------------------------------------------------------------------------
// Vocabularies
//
// Exported as runtime arrays as well as types: validating a channel string at
// an application boundary is common enough that every consumer would otherwise
// retype the list, and a retyped list is a list that goes stale.
// ---------------------------------------------------------------------------

/** Channels a message can be sent over. */
export const OUTBOUND_CHANNELS = [
  'APPLE_MB',
  'INSTAGRAM_DM',
  'LINE_ON',
  'MESSENGER',
  'MMS',
  'RCS',
  'SMS',
  'VIBER_BM',
  'VIBER_BOT',
  'WHATSAPP',
] as const satisfies readonly Schemas['OutboundMessageChannel'][];

/** A channel a message can be sent over. */
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

/**
 * Channels `GET /messages-api/1/inbound` can be polled for.
 *
 * Narrower than {@link OUTBOUND_CHANNELS} — pull-based inbound retrieval is not
 * offered on every channel you can send over. The rest deliver inbound messages
 * by webhook only.
 */
export const INBOUND_PULL_CHANNELS = [
  'APPLE_MB',
  'MESSENGER',
  'MMS',
  'SMS',
  'VIBER_BM',
  'WHATSAPP',
] as const satisfies readonly Schemas['InboundMoGetEndpointChannel'][];

/** A channel inbound messages can be pulled for. */
export type InboundPullChannel = (typeof INBOUND_PULL_CHANNELS)[number];

/** Channels delivery reports can arrive for — wider than the send channels. */
export const REPORT_CHANNELS = [
  'APPLE_MB',
  'INSTAGRAM_DM',
  'LINE_ON',
  'MESSENGER',
  'MMS',
  'RCS',
  'SMS',
  'VIBER_BM',
  'VIBER_BOT',
  'WHATSAPP',
  'KAKAO',
  'ZALO',
  'VOICE',
  'TELEGRAM',
] as const satisfies readonly Schemas['InboundDlrChannel'][];

/** A channel a delivery report can arrive for. */
export type ReportChannel = (typeof REPORT_CHANNELS)[number];

/** Coarse delivery outcome. `PENDING` and `ACCEPTED` are not yet terminal. */
export const MESSAGE_STATUS_GROUPS = [
  'ACCEPTED',
  'PENDING',
  'UNDELIVERABLE',
  'DELIVERED',
  'EXPIRED',
  'REJECTED',
] as const satisfies readonly Schemas['MessageGeneralStatus'][];

/** Coarse delivery outcome for a message. */
export type MessageStatusGroup = (typeof MESSAGE_STATUS_GROUPS)[number];

/** Status groups that will not change again. */
export const TERMINAL_STATUS_GROUPS = [
  'DELIVERED',
  'UNDELIVERABLE',
  'EXPIRED',
  'REJECTED',
] as const satisfies readonly MessageStatusGroup[];

/** Content types a message body can carry. */
export const MESSAGE_BODY_TYPES = [
  'TEXT',
  'IMAGE',
  'VIDEO',
  'DOCUMENT',
  'RICH_LINK',
  'AUTHENTICATION_REQUEST',
  'LIST',
  'CAROUSEL',
  'LOCATION',
  'CONTACT',
  'STICKER',
  'PRODUCT',
  'MIXED',
  'FLOW',
  'TIME_PICKER',
  'ORDER_REQUEST',
  'ORDER_STATUS',
  'FORM',
] as const satisfies readonly Schemas['MessagesApiMessageBodyType'][];

/** A content type a message body can carry. */
export type MessageBodyType = (typeof MESSAGE_BODY_TYPES)[number];

/** Events you can send to a conversation. */
export const OUTBOUND_EVENT_TYPES = [
  'TYPING_STARTED',
  'TYPING_STOPPED',
  'SEEN',
] as const satisfies readonly Schemas['MessagesApiOutboundEventType'][];

/** An event you can send to a conversation. */
export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Narrow an inbound event to a received message. */
export function isInboundMessage(event: InboundEvent): event is InboundMessageEvent {
  return event.event === 'MO';
}

/**
 * True when a status group will not change again.
 *
 * Takes a `string` because a delivery report's `groupName` is declared as one —
 * see {@link DeliveryStatus} — and narrows it on the way through, so the result
 * is usable with either status shape.
 */
export function isTerminalStatus(group: string | undefined): group is MessageStatusGroup {
  return group !== undefined && (TERMINAL_STATUS_GROUPS as readonly string[]).includes(group);
}

/** True when `value` names a status group. */
export function isMessageStatusGroup(value: unknown): value is MessageStatusGroup {
  return typeof value === 'string' && (MESSAGE_STATUS_GROUPS as readonly string[]).includes(value);
}

/** True when the message reached the recipient. Accepts either status shape. */
export function isDelivered(status: MessageStatus | DeliveryStatus | undefined): boolean {
  return status?.groupName === 'DELIVERED';
}

/** True when `value` is a channel a message can be sent over. */
export function isOutboundChannel(value: unknown): value is OutboundChannel {
  return typeof value === 'string' && (OUTBOUND_CHANNELS as readonly string[]).includes(value);
}

/** True when `value` is a channel inbound messages can be pulled for. */
export function isInboundPullChannel(value: unknown): value is InboundPullChannel {
  return typeof value === 'string' && (INBOUND_PULL_CHANNELS as readonly string[]).includes(value);
}
