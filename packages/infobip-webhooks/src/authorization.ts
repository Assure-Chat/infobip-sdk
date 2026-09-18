import { WebhookRejectionError } from './errors.js';
import { getHeader, type HeadersLike } from './headers.js';

/**
 * How to decide a delivery really came from Infobip.
 *
 * **Infobip does not sign these webhooks.** The OpenAPI document declares no
 * signature header and no `security` on any of the three webhook operations,
 * so there is nothing to verify cryptographically — this package would be lying
 * if it offered a `verifySignature`. What the platform does offer is the
 * ability to attach credentials to the callback URL you register, and that is
 * what this guard checks.
 *
 * Pick one:
 *
 * - `{ secret, header }` — you registered a callback URL with a custom header
 *   carrying a shared secret. The comparison is constant-time.
 * - `{ basic: { username, password } }` — you registered `https://user:pass@…`
 *   and the platform sends an `Authorization: Basic` header.
 * - `{ custom }` — anything else: mutual TLS terminated upstream, an IP
 *   allowlist, a signed path segment. Return false to reject.
 * - `'none'` — no check at all. Only sane when something in front of your
 *   handler already authenticated the request, and you have to say so
 *   explicitly rather than getting it by leaving an option out.
 *
 * Whatever you choose, the endpoint should also be treated as untrusted input:
 * a shared secret in a header is a bearer credential, so serve the endpoint
 * over TLS and rotate it like any other.
 */
export type WebhookAuthorization =
  | 'none'
  | {
      /** The expected secret value. */
      secret: string;
      /** Header carrying it. Default `x-infobip-webhook-secret`. */
      header?: string;
    }
  | {
      basic: { username: string; password: string };
    }
  | {
      custom: (input: { headers: HeadersLike; body: string }) => boolean | Promise<boolean>;
    };

/** Default header name for the shared-secret scheme. */
export const DEFAULT_SECRET_HEADER = 'x-infobip-webhook-secret';

/**
 * Apply the configured check, throwing {@link WebhookRejectionError} on failure.
 *
 * @internal
 */
export async function authorizeDelivery(
  authorization: WebhookAuthorization,
  input: { headers: HeadersLike; body: string },
): Promise<void> {
  if (authorization === 'none') return;

  if ('custom' in authorization) {
    const ok = await authorization.custom(input);
    if (!ok) throw new WebhookRejectionError('unauthorized', 'The custom authorization check rejected this delivery');
    return;
  }

  if ('basic' in authorization) {
    const header = getHeader(input.headers, 'authorization');
    if (header === undefined) {
      throw new WebhookRejectionError('unauthorized', 'No Authorization header on the delivery');
    }
    const [scheme, encoded] = header.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'basic' || !encoded) {
      throw new WebhookRejectionError('unauthorized', 'The Authorization header is not a Basic credential');
    }
    const expected = base64(`${authorization.basic.username}:${authorization.basic.password}`);
    if (!timingSafeEqual(encoded, expected)) {
      throw new WebhookRejectionError('unauthorized', 'Basic credentials did not match');
    }
    return;
  }

  const headerName = authorization.header ?? DEFAULT_SECRET_HEADER;
  const presented = getHeader(input.headers, headerName);
  if (presented === undefined) {
    throw new WebhookRejectionError('unauthorized', `No ${headerName} header on the delivery`);
  }
  if (!timingSafeEqual(presented, authorization.secret)) {
    throw new WebhookRejectionError('unauthorized', `The ${headerName} header did not match`);
  }
}

/**
 * Compare two strings without leaking their common prefix through timing.
 *
 * Length is compared up front — it is not secret, and the loop needs a fixed
 * bound. Everything after that runs over the full length regardless of where
 * the first difference is.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
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
