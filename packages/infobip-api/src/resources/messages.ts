import type {
  AnyOutboundMessage,
  MessageBody,
  MessageOptions,
  MessageWebhooks,
  OutboundChannel,
  RequestOptions as MessagesRequestOptions,
  SendMessagesRequest,
  SendMessagesResponse,
  ValidationBadResponse,
  ValidationOkResponse,
} from '@assure-ai/infobip-types';
import { InfobipConfigError } from '../errors.js';
import { Resource, type RequestOverrides } from './base.js';

/** The common shape of the convenience senders: who it goes to, and how. */
interface SendCommon extends RequestOverrides {
  /** Channel to send over. */
  channel: OutboundChannel;
  /** One recipient address, or several. */
  to: string | readonly string[];
  /** Sender ID registered for the channel. */
  sender?: string;
  /** Your own message id. Auto-generated when omitted. */
  messageId?: string;
  /** Per-message options — scheduling, validity, traffic type. */
  options?: MessageOptions;
  /** Where reports for this message are delivered. */
  webhooks?: MessageWebhooks;
}

export interface SendTextParams extends SendCommon {
  /** The text to send. */
  text: string;
}

export interface SendImageParams extends SendCommon {
  /** Publicly reachable URL of the image. */
  url: string;
  /** Caption shown with the image. */
  text?: string;
}

export interface SendAuthenticationRequestParams extends SendCommon {
  /** The text shown with the authentication prompt. */
  text: string;
  /** Scopes the authentication request asks for. */
  scopes?: readonly string[];
  /** Image shown alongside the prompt. */
  imageUrl?: string;
}

export interface SendBodyParams extends SendCommon {
  /** Any message body the channel supports. */
  body: MessageBody;
}

export interface SendParams extends RequestOverrides {
  /** The messages to send, in full spec shape. */
  messages: readonly AnyOutboundMessage[];
  /** Options applied to every message in this request. */
  options?: MessagesRequestOptions;
}

/** What {@link MessagesResource.validate} concluded about a payload. */
export type ValidationResult =
  | ({ valid: true } & ValidationOkResponse)
  | ({ valid: false } & ValidationBadResponse);

/**
 * Sending messages — `POST /messages-api/1/messages` and its validate twin.
 *
 * {@link send} takes the request exactly as the spec defines it. The other
 * methods are shorthands for the shapes you reach for most; each builds the
 * same request and returns the same response.
 */
export class MessagesResource extends Resource {
  /**
   * Send one or more messages.
   *
   * Every message in one call shares a bulk id, which is what delivery reports
   * are grouped by. The response carries that id even when you did not set one.
   *
   * ```ts
   * await client.messages.send({
   *   messages: [
   *     {
   *       channel: 'WHATSAPP',
   *       sender: '441134960000',
   *       destinations: [{ to: '441134960001' }],
   *       content: { body: { type: 'TEXT', text: 'Your code is 114233.' } },
   *     },
   *   ],
   * });
   * ```
   */
  async send(params: SendParams): Promise<SendMessagesResponse> {
    const { messages, options, ...overrides } = params;
    if (messages.length === 0) {
      throw new InfobipConfigError('`messages` must contain at least one message');
    }
    const body: SendMessagesRequest = {
      messages: [...messages],
      ...(options ? { options } : {}),
    };
    return this.http.request<SendMessagesResponse>({
      method: 'POST',
      path: 'messages-api/1/messages',
      body,
      ...toRequestInit(overrides),
    });
  }

  /** Send a plain text message. */
  async sendText(params: SendTextParams): Promise<SendMessagesResponse> {
    const { text, ...rest } = params;
    return this.#sendSingle({ type: 'TEXT', text }, rest);
  }

  /** Send an image, optionally captioned. */
  async sendImage(params: SendImageParams): Promise<SendMessagesResponse> {
    const { url, text, ...rest } = params;
    return this.#sendSingle({ type: 'IMAGE', url, ...(text !== undefined ? { text } : {}) }, rest);
  }

  /**
   * Send an authentication request — the branded prompt that replaces an SMS
   * one-time code on the channels that support it.
   *
   * The recipient's reply arrives as an inbound message whose content includes
   * an `AUTHENTICATION_RESPONSE` part.
   */
  async sendAuthenticationRequest(
    params: SendAuthenticationRequestParams,
  ): Promise<SendMessagesResponse> {
    const { text, scopes, imageUrl, ...rest } = params;
    return this.#sendSingle(
      {
        type: 'AUTHENTICATION_REQUEST',
        text,
        ...(scopes ? { scopes: [...scopes] } : {}),
        ...(imageUrl !== undefined ? { imageUrl } : {}),
      },
      rest,
    );
  }

  /** Send one message with a body you build yourself — any of the 18 types. */
  async sendBody(params: SendBodyParams): Promise<SendMessagesResponse> {
    const { body, ...rest } = params;
    return this.#sendSingle(body, rest);
  }

  /**
   * Check a payload without sending it.
   *
   * The route answers an invalid payload with a 400 that carries the reasons,
   * which is a result and not a transport failure, so this returns it rather
   * than throwing: branch on `valid`. A 401, 429, or 5xx still throws.
   *
   * ```ts
   * const result = await client.messages.validate({ messages });
   * if (!result.valid) for (const violation of result.violations) report(violation);
   * ```
   *
   * `skippableViolations` is populated on both outcomes — warnings worth
   * reading even when the payload passed.
   */
  async validate(params: SendParams): Promise<ValidationResult> {
    const { messages, options, ...overrides } = params;
    if (messages.length === 0) {
      throw new InfobipConfigError('`messages` must contain at least one message');
    }
    const body: SendMessagesRequest = {
      messages: [...messages],
      ...(options ? { options } : {}),
    };
    const result = await this.http.requestWithStatus<ValidationOkResponse | ValidationBadResponse>({
      method: 'POST',
      path: 'messages-api/1/messages/validate',
      body,
      acceptStatuses: [400],
      ...toRequestInit(overrides),
    });
    return result.status === 400
      ? { valid: false, ...(result.data as ValidationBadResponse) }
      : { valid: true, ...(result.data as ValidationOkResponse) };
  }

  /** Wrap a body in a single-message request and send it. */
  async #sendSingle(
    body: MessageBody,
    common: Omit<SendCommon, keyof RequestOverrides> & RequestOverrides,
  ): Promise<SendMessagesResponse> {
    const { channel, to, sender, messageId, options, webhooks, ...overrides } = common;
    const recipients = typeof to === 'string' ? [to] : to;
    if (recipients.length === 0) {
      throw new InfobipConfigError('`to` must name at least one recipient');
    }
    if (recipients.length > 1 && messageId !== undefined) {
      // One id across several destinations would make the delivery reports
      // indistinguishable, which is the opposite of why you set one.
      throw new InfobipConfigError(
        '`messageId` applies to a single destination — send one message per recipient, ' +
          'or set `messageId` on each destination via `send()`',
      );
    }

    const message = {
      channel,
      ...(sender !== undefined ? { sender } : {}),
      destinations: recipients.map((recipient) => ({
        to: recipient,
        ...(messageId !== undefined ? { messageId } : {}),
      })),
      content: { body },
      ...(options ? { options } : {}),
      ...(webhooks ? { webhooks } : {}),
    } as AnyOutboundMessage;

    return this.send({ messages: [message], ...overrides });
  }
}

/** @internal */
export function toRequestInit(overrides: RequestOverrides): {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
} {
  return {
    ...(overrides.signal ? { signal: overrides.signal } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.headers ? { headers: overrides.headers } : {}),
  };
}
