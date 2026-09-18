import { InfobipConfigError } from './errors.js';

/**
 * A credential, reduced to the one thing the transport needs: the value of the
 * `Authorization` header.
 *
 * Infobip accepts four schemes on every Messages API route, and which one you
 * hold depends on how the account is set up rather than on what you are doing,
 * so the client takes any of them and this interface hides the difference.
 */
export interface AuthorizationProvider {
  /** The full header value, scheme included — `App abc…`, `Bearer eyJ…`. */
  getAuthorization(options?: { signal?: AbortSignal }): Promise<string>;
  /** Drop anything cached, so the next call re-derives the header. */
  invalidate(): void;
}

/** A token with a known lifetime, as returned by the OAuth2 token endpoint. */
export interface AccessToken {
  token: string;
  /** Epoch milliseconds at which the token stops being accepted. */
  expiresAt?: number;
}

/** `Authorization: App <key>` — the scheme Infobip recommends for servers. */
export class ApiKeyAuthorizationProvider implements AuthorizationProvider {
  readonly #header: string;

  constructor(apiKey: string) {
    const key = apiKey.trim();
    if (key === '') throw new InfobipConfigError('`apiKey` must not be empty');
    // A pasted key sometimes arrives with the scheme already attached.
    this.#header = /^App\s/i.test(key) ? key : `App ${key}`;
  }

  async getAuthorization(): Promise<string> {
    return this.#header;
  }

  invalidate(): void {
    // Nothing is cached — the key is the credential.
  }
}

/** `Authorization: Basic <base64>` — for the routes that predate API keys. */
export class BasicAuthorizationProvider implements AuthorizationProvider {
  readonly #header: string;

  constructor(username: string, password: string) {
    if (username === '') throw new InfobipConfigError('`basic.username` must not be empty');
    if (username.includes(':')) {
      // The colon separates the pair, so one inside the username is unparseable.
      throw new InfobipConfigError('`basic.username` must not contain a colon');
    }
    this.#header = `Basic ${base64(`${username}:${password}`)}`;
  }

  async getAuthorization(): Promise<string> {
    return this.#header;
  }

  invalidate(): void {
    // Nothing is cached.
  }
}

/** `Authorization: IBSSO <token>` — a session token from the portal login flow. */
export class IbssoAuthorizationProvider implements AuthorizationProvider {
  readonly #header: string;

  constructor(token: string) {
    const value = token.trim();
    if (value === '') throw new InfobipConfigError('`ibssoToken` must not be empty');
    this.#header = /^IBSSO\s/i.test(value) ? value : `IBSSO ${value}`;
  }

  async getAuthorization(): Promise<string> {
    return this.#header;
  }

  invalidate(): void {
    // Nothing is cached; IBSSO sessions expire server-side on idle.
  }
}

/** `Authorization: Bearer <token>` for a token whose lifetime you manage. */
export class StaticBearerAuthorizationProvider implements AuthorizationProvider {
  readonly #header: string;

  constructor(token: string) {
    const value = token.trim();
    if (value === '') throw new InfobipConfigError('`oauthToken` must not be empty');
    this.#header = /^Bearer\s/i.test(value) ? value : `Bearer ${value}`;
  }

  async getAuthorization(): Promise<string> {
    return this.#header;
  }

  invalidate(): void {
    // Nothing is cached.
  }
}

/**
 * Calls back for a credential and caches it until it is near expiry.
 *
 * This is the hook for an OAuth2 client-credentials grant: mint a token against
 * `auth/1/oauth2/token`, return it with its `expiresAt`, and the client
 * refreshes on its own before the token dies.
 */
export class CallbackAuthorizationProvider implements AuthorizationProvider {
  readonly #getCredential: (options: {
    signal?: AbortSignal;
  }) => Promise<string | AccessToken>;
  readonly #refreshSkewMs: number;
  readonly #scheme: string;
  #cached: { header: string; expiresAt: number | undefined } | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(
    getCredential: (options: { signal?: AbortSignal }) => Promise<string | AccessToken>,
    options: { refreshSkewMs?: number; scheme?: string } = {},
  ) {
    this.#getCredential = getCredential;
    this.#refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.#scheme = options.scheme ?? 'Bearer';
  }

  async getAuthorization(options: { signal?: AbortSignal } = {}): Promise<string> {
    const cached = this.#cached;
    if (cached && !this.#isExpiring(cached.expiresAt)) return cached.header;

    // Collapse concurrent refreshes so a burst of calls mints one token.
    this.#inFlight ??= this.#refresh(options).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  async #refresh(options: { signal?: AbortSignal }): Promise<string> {
    const result = await this.#getCredential(options);
    const token = typeof result === 'string' ? result : result.token;
    if (typeof token !== 'string' || token.trim() === '') {
      throw new InfobipConfigError('The credential callback returned an empty token');
    }
    const header = hasScheme(token) ? token : `${this.#scheme} ${token}`;
    this.#cached = {
      header,
      expiresAt: typeof result === 'string' ? undefined : result.expiresAt,
    };
    return header;
  }

  #isExpiring(expiresAt: number | undefined): boolean {
    if (expiresAt === undefined) return false;
    return Date.now() >= expiresAt - this.#refreshSkewMs;
  }
}

/** True when the string already starts with an HTTP auth scheme. */
function hasScheme(value: string): boolean {
  return /^(App|Basic|Bearer|IBSSO)\s/i.test(value);
}

/** Base64, on Node and on every runtime with `btoa`. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } })
    .Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
