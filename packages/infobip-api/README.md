# @assure/infobip-api

Typed client for the [Infobip Messages API](https://www.infobip.com/docs/api/platform/messages-api).

```bash
npm install @assure/infobip-api
```

```ts
import { InfobipClient } from '@assure/infobip-api';

const client = new InfobipClient({
  baseUrl: process.env.INFOBIP_BASE_URL!,
  apiKey: process.env.INFOBIP_API_KEY!,
});

await client.messages.sendText({
  channel: 'RCS',
  sender: 'Assure',
  to: '441134960001',
  text: 'Your verification code is 114233.',
});
```

## Authentication

Infobip accepts four schemes on every route; give the client exactly one.

```ts
new InfobipClient({ baseUrl, apiKey: 'abc…' });                              // Authorization: App abc…
new InfobipClient({ baseUrl, basic: { username, password } });               // Authorization: Basic …
new InfobipClient({ baseUrl, ibssoToken: 'session…' });                      // Authorization: IBSSO …
new InfobipClient({ baseUrl, oauthToken: 'eyJ…' });                          // Authorization: Bearer …

// Or mint one yourself; return `expiresAt` and it is cached and refreshed.
new InfobipClient({
  baseUrl,
  getCredential: async () => {
    const { access_token, expires_in } = await mintToken();
    return { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  },
});
```

`InfobipClient.fromEnv()` reads `INFOBIP_BASE_URL` plus one of `INFOBIP_API_KEY`,
`INFOBIP_OAUTH_TOKEN`, `INFOBIP_IBSSO_TOKEN`, or `INFOBIP_USERNAME` + `INFOBIP_PASSWORD`.

`baseUrl` is required and has no default — each Infobip account has its own API host.

## Sending

```ts
// Shorthands for the common bodies.
await client.messages.sendText({ channel: 'SMS', to, text: 'hello' });
await client.messages.sendImage({ channel: 'WHATSAPP', to, url, text: 'caption' });
await client.messages.sendAuthenticationRequest({ channel: 'APPLE_MB', sender, to, text: 'Confirm it is you' });

// Any of the eighteen body types.
await client.messages.sendBody({
  channel: 'RCS',
  sender,
  to,
  body: { type: 'RICH_LINK', url: 'https://assure.chat', title: 'Assure' },
});

// Or the request exactly as the spec defines it — bulks, failover, scheduling.
await client.messages.send({
  messages: [{ channel: 'RCS', sender, destinations: [{ to }], content: { body } }],
  options: { schedule: { sendAt: '2026-09-20T09:00:00.000+0000' } },
});
```

`content.body` narrows on `type`, so `body.text` and `body.url` complete and typecheck.

## Validating

`POST /messages/validate` reports an invalid payload as a 400 carrying the reasons. That is the
route working, so it comes back as a result rather than an exception:

```ts
const result = await client.messages.validate({ messages });
if (!result.valid) {
  for (const violation of result.violations) console.error(violation.property, violation.violation);
}
```

`skippableViolations` is populated on both outcomes — warnings worth reading even when it passed.

## Events

Typing indicators and read receipts. Channel support is narrow and in the types:

```ts
await client.events.typingStarted({ channel: 'RCS', sender, to });   // Apple MB, RCS, WhatsApp
await client.events.typingStopped({ channel: 'APPLE_MB', sender, to }); // Apple MB only
await client.events.seen({ channel: 'RCS', sender, to, messageId }); // RCS only
```

## Pull queues

`reports` and `inbound` read destructive queues — each record is handed out once.

```ts
const { results } = await client.reports.fetch({ channel: 'RCS', limit: 100 });

for await (const report of client.reports.drain({ channel: 'SMS' })) {
  await record(report.messageId, report.status?.groupName);
}

for await (const event of client.inbound.drain({ channel: 'WHATSAPP' })) {
  if (event.event === 'MO') await handle(event);
}
```

Because a read consumes the batch, neither route is replayed after a failure with an unknown
outcome — a replay returns the *next* batch and the first one is lost. Pass
`replayOnUnknownOutcome: true` where that is acceptable. A `429` or `503` is retried regardless:
the server refused the request, so nothing was dequeued.

Prefer webhooks (`@assure/infobip-webhooks`) where you can expose a URL. Records are kept 48 hours.

## Errors

Every failure is an `InfobipError`. Non-2xx responses become the most specific subclass:

| Class | Status |
| --- | --- |
| `InfobipValidationError` | 400, 422 — see `.violations` |
| `InfobipAuthenticationError` | 401 |
| `InfobipPermissionError` | 403 |
| `InfobipNotFoundError` | 404 |
| `InfobipRateLimitError` | 429 — see `.retryAfterMs` |
| `InfobipServerError` | 5xx |
| `InfobipTimeoutError` / `InfobipConnectionError` | no response |
| `InfobipConfigError` | bad arguments, thrown before any request |

`.code`, `.action`, and `.violations` are parsed from whichever envelope the platform sent —
the Messages API shape, the older `requestError.serviceException` shape, or neither.

## Retries

Retried on every route, including sends: `408`, `429`, `503`. The server states it did nothing,
so a replay cannot duplicate anything.

Retried only where a replay is safe: everything else — an ambiguous `500`/`502`/`504`, a timeout,
a socket error. This API has no idempotency key, so a blind replay of a send is a second message.
A `401` triggers one credential re-derivation and a single retry.

## License

MIT
