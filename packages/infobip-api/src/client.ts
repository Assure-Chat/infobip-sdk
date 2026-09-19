import {
  ApiKeyAuthorizationProvider,
  BasicAuthorizationProvider,
  CallbackAuthorizationProvider,
  IbssoAuthorizationProvider,
  StaticBearerAuthorizationProvider,
  type AccessToken,
  type AuthorizationProvider,
} from './auth.js';
import { InfobipConfigError } from './errors.js';
import {
  HttpClient,
  type FetchLike,
  type RequestHook,
  type ResponseHook,
  type RetryOptions,
} from './http.js';
import { EventsResource } from './resources/events.js';
import { InboundResource } from './resources/inbound.js';
import { MessagesResource } from './resources/messages.js';
import { ReportsResource } from './resources/reports.js';

/** Username and password for the Basic scheme. */
export interface BasicCredentials {
  username: string;
  password: string;
}

export interface InfobipClientOptions {
  /**
   * Your account's API host, as shown on the Infobip portal's API page —
   * `https://xyz1a2.api.infobip.com`.
   *
   * Required, and there is no default: Infobip assigns each account its own
   * host and the shared `api.infobip.com` will not serve your traffic. The spec
   * declares no `servers` entry for this reason.
   */
  baseUrl: string;

  /** An API key. Sent as `Authorization: App <key>`. The recommended scheme. */
  apiKey?: string;
  /** Portal username and password, sent as `Authorization: Basic …`. */
  basic?: BasicCredentials;
  /** A session token from the portal login flow, sent as `IBSSO <token>`. */
  ibssoToken?: string;
  /** An OAuth2 access token you already hold, sent as `Bearer <token>`. */
  oauthToken?: string;
  /**
   * A callback that returns a credential, for tokens you mint yourself.
   *
   * Return an {@link AccessToken} with `expiresAt` and the client caches it,
   * refreshing shortly before expiry. Return a bare string and it is used once
   * per request. A returned value that already carries a scheme (`App …`,
   * `Bearer …`) is sent as-is; otherwise `Bearer` is assumed.
   */
  getCredential?: (options: { signal?: AbortSignal }) => Promise<string | AccessToken>;

  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Retry policy. Applies to writes and to reads that are safe to replay. */
  retry?: RetryOptions;
  /** Refresh a callback credential this many ms before it expires. Default 60000. */
  refreshSkewMs?: number;
  /** Headers merged into every request. Per-call headers win. */
  headers?: Record<string, string>;
  /** Value sent as `user-agent`. */
  userAgent?: string;
  /** Custom fetch implementation — useful for proxies, mocks, and tests. */
  fetch?: FetchLike;
  /** Called before each attempt, including retries. */
  onRequest?: RequestHook;
  /** Called after each response, including ones that will be retried. */
  onResponse?: ResponseHook;
}

/**
 * Client for the Infobip Messages API.
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
export class InfobipClient {
  /** Sending messages, and validating a payload without sending it. */
  readonly messages: MessagesResource;
  /** Typing indicators and read receipts. */
  readonly events: EventsResource;
  /** The delivery-report pull queue. */
  readonly reports: ReportsResource;
  /** The inbound-message pull queue. */
  readonly inbound: InboundResource;

  readonly #http: HttpClient;
  readonly #authorization: AuthorizationProvider;

  constructor(options: InfobipClientOptions) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#authorization = buildAuthorizationProvider(options);

    this.#http = new HttpClient({
      baseUrl,
      authorization: this.#authorization,
      fetch: options.fetch,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      onRequest: options.onRequest,
      onResponse: options.onResponse,
    });

    this.messages = new MessagesResource(this.#http);
    this.events = new EventsResource(this.#http);
    this.reports = new ReportsResource(this.#http);
    this.inbound = new InboundResource(this.#http);
  }

  /**
   * Build a client from the environment: `INFOBIP_BASE_URL` plus one of
   * `INFOBIP_API_KEY`, `INFOBIP_OAUTH_TOKEN`, `INFOBIP_IBSSO_TOKEN`, or the
   * pair `INFOBIP_USERNAME` / `INFOBIP_PASSWORD`. Explicit options win.
   */
  static fromEnv(options: Partial<InfobipClientOptions> = {}): InfobipClient {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const baseUrl = options.baseUrl ?? env?.['INFOBIP_BASE_URL'];
    if (!baseUrl) {
      throw new InfobipConfigError(
        'Set INFOBIP_BASE_URL (or pass `baseUrl`) — each account has its own API host',
      );
    }

    const apiKey = options.apiKey ?? env?.['INFOBIP_API_KEY'];
    const oauthToken = options.oauthToken ?? env?.['INFOBIP_OAUTH_TOKEN'];
    const ibssoToken = options.ibssoToken ?? env?.['INFOBIP_IBSSO_TOKEN'];
    const username = env?.['INFOBIP_USERNAME'];
    const password = env?.['INFOBIP_PASSWORD'];
    const basic =
      options.basic ?? (username && password !== undefined ? { username, password } : undefined);

    if (!apiKey && !oauthToken && !ibssoToken && !basic && !options.getCredential) {
      throw new InfobipConfigError(
        'Set INFOBIP_API_KEY (or INFOBIP_OAUTH_TOKEN, INFOBIP_IBSSO_TOKEN, or ' +
          'INFOBIP_USERNAME + INFOBIP_PASSWORD) to build a client from the environment',
      );
    }

    return new InfobipClient({
      ...options,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(oauthToken ? { oauthToken } : {}),
      ...(ibssoToken ? { ibssoToken } : {}),
      ...(basic ? { basic } : {}),
    });
  }

  /** The host every request is sent to. */
  get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /**
   * Drop any cached credential, so the next request derives a fresh one. Only
   * meaningful with `getCredential` — the other schemes cache nothing.
   */
  invalidateCredential(): void {
    this.#authorization.invalidate();
  }

  /** The `Authorization` header the next request would send. */
  async getAuthorizationHeader(options: { signal?: AbortSignal } = {}): Promise<string> {
    return this.#authorization.getAuthorization(options);
  }
}

/** Accept a host with or without a scheme; reject anything unusable. */
function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new InfobipConfigError(
      '`baseUrl` is required — use the API host shown on your Infobip portal, ' +
        'e.g. https://xyz1a2.api.infobip.com',
    );
  }
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new InfobipConfigError(`\`baseUrl\` is not a valid URL: ${raw}`, { cause });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new InfobipConfigError('`baseUrl` must not carry a query string or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Pick exactly one credential and wrap it in a provider. */
function buildAuthorizationProvider(options: InfobipClientOptions): AuthorizationProvider {
  const supplied = [
    options.apiKey !== undefined ? 'apiKey' : undefined,
    options.basic !== undefined ? 'basic' : undefined,
    options.ibssoToken !== undefined ? 'ibssoToken' : undefined,
    options.oauthToken !== undefined ? 'oauthToken' : undefined,
    options.getCredential !== undefined ? 'getCredential' : undefined,
  ].filter((name): name is string => name !== undefined);

  if (supplied.length === 0) {
    throw new InfobipConfigError(
      'Provide one of `apiKey`, `basic`, `ibssoToken`, `oauthToken`, or `getCredential`',
    );
  }
  if (supplied.length > 1) {
    throw new InfobipConfigError(
      `Provide exactly one credential — got ${supplied.join(', ')}. They are mutually exclusive.`,
    );
  }

  if (options.apiKey !== undefined) return new ApiKeyAuthorizationProvider(options.apiKey);
  if (options.basic !== undefined) {
    return new BasicAuthorizationProvider(options.basic.username, options.basic.password);
  }
  if (options.ibssoToken !== undefined) return new IbssoAuthorizationProvider(options.ibssoToken);
  if (options.oauthToken !== undefined) {
    return new StaticBearerAuthorizationProvider(options.oauthToken);
  }
  return new CallbackAuthorizationProvider(options.getCredential!, {
    ...(options.refreshSkewMs !== undefined ? { refreshSkewMs: options.refreshSkewMs } : {}),
  });
}
