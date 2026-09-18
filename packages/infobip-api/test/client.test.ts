import { describe, expect, it } from 'vitest';
import { InfobipClient, InfobipConfigError } from '../src/index.js';

const BASE = 'https://xyz1a2.api.infobip.com';

describe('InfobipClient construction', () => {
  it('requires a base URL, because each account has its own host', () => {
    expect(() => new InfobipClient({ apiKey: 'k' } as never)).toThrow(InfobipConfigError);
    expect(() => new InfobipClient({ baseUrl: '', apiKey: 'k' })).toThrow(/baseUrl` is required/);
  });

  it('accepts a bare host and adds the scheme', () => {
    const client = new InfobipClient({ baseUrl: 'xyz1a2.api.infobip.com', apiKey: 'k' });
    expect(client.baseUrl).toBe('https://xyz1a2.api.infobip.com');
  });

  it('strips a trailing slash so paths join predictably', () => {
    const client = new InfobipClient({ baseUrl: `${BASE}/`, apiKey: 'k' });
    expect(client.baseUrl).toBe(BASE);
  });

  it('rejects a base URL carrying a query string', () => {
    expect(() => new InfobipClient({ baseUrl: `${BASE}?x=1`, apiKey: 'k' })).toThrow(
      /query string or fragment/,
    );
  });

  it('requires exactly one credential', () => {
    expect(() => new InfobipClient({ baseUrl: BASE })).toThrow(/Provide one of/);
    expect(
      () => new InfobipClient({ baseUrl: BASE, apiKey: 'k', oauthToken: 't' }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects an empty API key rather than sending `App `', () => {
    expect(() => new InfobipClient({ baseUrl: BASE, apiKey: '   ' })).toThrow(/must not be empty/);
  });
});

describe('authorization headers', () => {
  it('sends an API key as the App scheme', async () => {
    const client = new InfobipClient({ baseUrl: BASE, apiKey: 'secret-key' });
    expect(await client.getAuthorizationHeader()).toBe('App secret-key');
  });

  it('does not double-prefix a key that already carries its scheme', async () => {
    const client = new InfobipClient({ baseUrl: BASE, apiKey: 'App secret-key' });
    expect(await client.getAuthorizationHeader()).toBe('App secret-key');
  });

  it('base64-encodes basic credentials', async () => {
    const client = new InfobipClient({
      baseUrl: BASE,
      basic: { username: 'Aladdin', password: 'openSesame' },
    });
    expect(await client.getAuthorizationHeader()).toBe('Basic QWxhZGRpbjpvcGVuU2VzYW1l');
  });

  it('rejects a username containing the separator', () => {
    expect(
      () => new InfobipClient({ baseUrl: BASE, basic: { username: 'a:b', password: 'c' } }),
    ).toThrow(/must not contain a colon/);
  });

  it('sends an IBSSO token as the IBSSO scheme', async () => {
    const client = new InfobipClient({ baseUrl: BASE, ibssoToken: 'session-token' });
    expect(await client.getAuthorizationHeader()).toBe('IBSSO session-token');
  });

  it('sends an OAuth token as a bearer', async () => {
    const client = new InfobipClient({ baseUrl: BASE, oauthToken: 'jwt' });
    expect(await client.getAuthorizationHeader()).toBe('Bearer jwt');
  });
});

describe('credential callback', () => {
  it('caches a token until it nears expiry, then mints a new one', async () => {
    let mints = 0;
    const client = new InfobipClient({
      baseUrl: BASE,
      refreshSkewMs: 0,
      getCredential: async () => {
        mints += 1;
        return { token: `token-${mints}`, expiresAt: Date.now() + 10_000 };
      },
    });

    expect(await client.getAuthorizationHeader()).toBe('Bearer token-1');
    expect(await client.getAuthorizationHeader()).toBe('Bearer token-1');
    expect(mints).toBe(1);

    client.invalidateCredential();
    expect(await client.getAuthorizationHeader()).toBe('Bearer token-2');
    expect(mints).toBe(2);
  });

  it('re-mints once a cached token is inside the refresh skew', async () => {
    let mints = 0;
    const client = new InfobipClient({
      baseUrl: BASE,
      refreshSkewMs: 60_000,
      getCredential: async () => {
        mints += 1;
        // Expires in 30s — already inside the 60s skew, so never reusable.
        return { token: `token-${mints}`, expiresAt: Date.now() + 30_000 };
      },
    });

    await client.getAuthorizationHeader();
    await client.getAuthorizationHeader();
    expect(mints).toBe(2);
  });

  it('collapses concurrent refreshes into one mint', async () => {
    let mints = 0;
    const client = new InfobipClient({
      baseUrl: BASE,
      getCredential: async () => {
        mints += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { token: 'token', expiresAt: Date.now() + 600_000 };
      },
    });

    await Promise.all([
      client.getAuthorizationHeader(),
      client.getAuthorizationHeader(),
      client.getAuthorizationHeader(),
    ]);
    expect(mints).toBe(1);
  });

  it('keeps a token with no stated expiry', async () => {
    let mints = 0;
    const client = new InfobipClient({
      baseUrl: BASE,
      getCredential: async () => {
        mints += 1;
        return 'opaque-token';
      },
    });

    expect(await client.getAuthorizationHeader()).toBe('Bearer opaque-token');
    expect(await client.getAuthorizationHeader()).toBe('Bearer opaque-token');
    expect(mints).toBe(1);
  });

  it('passes through a credential that already names its scheme', async () => {
    const client = new InfobipClient({
      baseUrl: BASE,
      getCredential: async () => 'App a-key',
    });
    expect(await client.getAuthorizationHeader()).toBe('App a-key');
  });

  it('rejects an empty token from the callback', async () => {
    const client = new InfobipClient({ baseUrl: BASE, getCredential: async () => '  ' });
    await expect(client.getAuthorizationHeader()).rejects.toThrow(/empty token/);
  });
});
