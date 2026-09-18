# @assure/infobip-webhooks

Receivers for the three [Infobip Messages API](https://www.infobip.com/docs/api/platform/messages-api)
webhooks: delivery reports, seen reports, and inbound messages.

```bash
npm install @assure/infobip-webhooks
```

```ts
import { createExpressWebhookHandler } from '@assure/infobip-webhooks/express';

app.post(
  '/webhooks/infobip/inbound',
  createExpressWebhookHandler({
    kind: 'inbound-message',
    authorization: { secret: process.env.INFOBIP_WEBHOOK_SECRET! },
    onMessage: async (message) => {
      await enqueue(message);   // narrowed to a received message
    },
  }),
);
```

## Infobip does not sign these webhooks

The OpenAPI document declares no signature header and no `security` on any of the three webhook
operations. There is nothing to verify cryptographically, so this package does not offer a
`verifySignature` that would only look reassuring.

What it checks instead is the credential *you* attached to the callback URL you registered:

```ts
{ secret: 's3cret' }                                  // x-infobip-webhook-secret, constant-time
{ secret: 's3cret', header: 'x-my-header' }           // a header name you chose
{ basic: { username, password } }                     // you registered https://user:pass@…
{ custom: ({ headers, body }) => check(headers) }     // mTLS upstream, IP allowlist, signed path
'none'                                                // no check — has to be written down
```

`'none'` is deliberately not the default and not reachable by omitting the option, so no
endpoint ends up unauthenticated because someone forgot. A shared secret in a header is a bearer
credential: serve the endpoint over TLS and rotate it.

## `kind` is required

Infobip posts each webhook to whatever URL you registered for it. Nothing in the request says
which one arrived, so the kind is a property of *your endpoint* — declare it per route:

```ts
new WebhookReceiver({ kind: 'delivery-report', … });
new WebhookReceiver({ kind: 'seen-report', … });
new WebhookReceiver({ kind: 'inbound-message', … });
```

Use `kind: 'auto'` only for an endpoint registered for more than one; it infers the kind from
the payload and rejects what it cannot classify rather than guessing.

## Handlers

```ts
{
  onDeliveryReports: (results, context) => {},  // whole batch
  onSeenReports:     (results, context) => {},
  onInboundEvents:   (events,  context) => {},  // including typing indicators
  onMessage:         (message, context) => {},  // received messages only — usually this one
  onDelivery:        (delivery, context) => {}, // every accepted delivery, before the above
  onUnhandled:       (delivery, context) => {}, // nothing covered it
  onError:           (error) => {},             // rejected, or a handler threw
}
```

## Responses

| Status | Meaning |
| --- | --- |
| `200` | Accepted and handled, or a duplicate already handled. |
| `401` | The authorization check rejected it. |
| `400` | Not parseable — bad JSON, no `results`, or an unclassifiable payload. |
| `500` | A handler threw. Infobip retries, which is what you want for a transient failure. |

## Deduplication

Infobip retries a callback that did not return a 2xx, so a handler that succeeded slowly can be
asked to run again. Give the receiver a cache and repeats are acknowledged without re-running:

```ts
new WebhookReceiver({
  kind: 'delivery-report',
  authorization: { secret },
  deduplicate: { seen: async (key) => (await redis.set(key, '1', 'NX', 'EX', 3600)) === null },
  onDeliveryReports: async (reports) => { await record(reports); },
});
```

The default key is the batch's message ids, because the platform retries the batch and not its
parts. Override with `deduplicationKey`.

## Adapters

```ts
import { createExpressWebhookHandler } from '@assure/infobip-webhooks/express';
import { createFastifyWebhookHandler } from '@assure/infobip-webhooks/fastify';
import { createFetchWebhookHandler }   from '@assure/infobip-webhooks/fetch';   // Workers, Deno, Bun, Next
import { createLambdaWebhookHandler }  from '@assure/infobip-webhooks/lambda';  // API Gateway, Function URLs
```

A JSON body parser upstream is fine. Nothing here depends on the exact request bytes — that
constraint belongs to signed webhooks, and these are not signed.

## XML delivery reports

Setting `webhooks.contentType` to `application/xml` on a sent message makes its delivery reports
arrive as XML. This package parses JSON only, and says so precisely
(`code: 'unsupported_content_type'`) rather than failing inside `JSON.parse`.

## Do I need a tunnel?

Only for what cannot be pulled:

| Webhook | Pull alternative | Tunnel |
| --- | --- | --- |
| Delivery reports | `GET /reports`, every channel | No |
| Inbound messages | `GET /inbound`, but **not** RCS, Instagram, LINE, Viber Bot | Only those channels |
| Seen reports | none | Yes |

## License

MIT
