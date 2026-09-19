/**
 * `@assure-ai/infobip-api` — a typed client for the Infobip Messages API.
 *
 * ```ts
 * import { InfobipClient } from '@assure-ai/infobip-api';
 *
 * const client = new InfobipClient({
 *   baseUrl: process.env.INFOBIP_BASE_URL!,
 *   apiKey: process.env.INFOBIP_API_KEY!,
 * });
 *
 * await client.messages.sendText({
 *   channel: 'WHATSAPP',
 *   sender: '441134960000',
 *   to: '441134960001',
 *   text: 'Your verification code is 114233.',
 * });
 * ```
 */
export { InfobipClient, type BasicCredentials, type InfobipClientOptions } from './client.js';

export {
  ApiKeyAuthorizationProvider,
  BasicAuthorizationProvider,
  CallbackAuthorizationProvider,
  IbssoAuthorizationProvider,
  StaticBearerAuthorizationProvider,
  type AccessToken,
  type AuthorizationProvider,
} from './auth.js';

export {
  InfobipApiError,
  InfobipAuthenticationError,
  InfobipConfigError,
  InfobipConnectionError,
  InfobipError,
  InfobipNotFoundError,
  InfobipPermissionError,
  InfobipRateLimitError,
  InfobipServerError,
  InfobipTimeoutError,
  InfobipValidationError,
  isInfobipApiError,
  type InfobipApiErrorInit,
} from './errors.js';

export type { FetchLike, RequestHook, ResponseHook, RetryOptions } from './http.js';

export type { RequestOverrides } from './resources/base.js';

export {
  MessagesResource,
  type SendAuthenticationRequestParams,
  type SendBodyParams,
  type SendImageParams,
  type SendParams,
  type SendTextParams,
  type ValidationResult,
} from './resources/messages.js';

export {
  EventsResource,
  type EventOptions,
  type SeenChannel,
  type SeenParams,
  type SendEventsParams,
  type TypingStartedChannel,
  type TypingStartedParams,
  type TypingStoppedChannel,
  type TypingStoppedParams,
} from './resources/events.js';

export {
  MAX_REPORT_LIMIT,
  ReportsResource,
  type DrainReportsParams,
  type FetchReportsParams,
} from './resources/reports.js';

export {
  InboundResource,
  MAX_INBOUND_LIMIT,
  type DrainInboundParams,
  type FetchInboundParams,
} from './resources/inbound.js';

// Re-exported so a consumer needs one dependency for the common path.
export type {
  AnyOutboundMessage,
  DeliveryReportsResponse,
  DeliveryResult,
  DeliveryStatus,
  InboundEvent,
  InboundMessageEvent,
  InboundMessagesResponse,
  InboundPullChannel,
  MessageBody,
  MessageContent,
  MessageResponse,
  MessageStatus,
  MessageStatusGroup,
  OutboundChannel,
  OutboundEvent,
  OutboundMessage,
  OutboundTemplateMessage,
  ReportChannel,
  SendMessagesRequest,
  SendMessagesResponse,
  ValidationBadResponse,
  ValidationOkResponse,
} from '@assure-ai/infobip-types';

export {
  INBOUND_PULL_CHANNELS,
  MESSAGE_BODY_TYPES,
  MESSAGE_STATUS_GROUPS,
  OUTBOUND_CHANNELS,
  REPORT_CHANNELS,
  isDelivered,
  isInboundMessage,
  isMessageStatusGroup,
  isTerminalStatus,
} from '@assure-ai/infobip-types';
