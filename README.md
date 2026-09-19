# Assure Infobip SDK

TypeScript packages for the [Infobip Messages API](https://www.infobip.com/docs/api/platform/messages-api) —
one API across Apple Messages for Business, RCS, WhatsApp, SMS, Viber, Messenger, Instagram, LINE, and MMS.

| Package | What it is |
| --- | --- |
| [`@assure-ai/infobip-types`](packages/infobip-types) | Types generated from the spec, plus the discriminated unions the generator cannot produce and the channel vocabularies as runtime values. |
| [`@assure-ai/infobip-api`](packages/infobip-api) | The client. All five endpoints, every auth scheme, typed errors, retries that respect what is safe to replay. |
| [`@assure-ai/infobip-webhooks`](packages/infobip-webhooks) | Receivers for the three webhooks, with Express, Fastify, Fetch, and Lambda adapters. |

```bash
npm install @assure-ai/infobip-api
```

```ts
import { InfobipClient } from '@assure-ai/infobip-api';

const client = new InfobipClient({
  baseUrl: process.env.INFOBIP_BASE_URL!,   // your account host — see below
  apiKey: process.env.INFOBIP_API_KEY!,
});

await client.messages.sendText({
  channel: 'RCS',
  sender: 'Assure',
  to: '441134960001',
  text: 'Your verification code is 114233.',
});
```

---

## The five things worth knowing before you start

### 1. There is no default base URL

Infobip assigns each account its own API host — `https://xxxxx.api.infobip.com`, not
`api.infobip.com`. The OpenAPI document declares no `servers` entry for exactly this reason,
so `baseUrl` is a required option with no fallback. It is on the
[portal's API page](https://portal.infobip.com).

### 2. The pull queues are destructive, so the client does not blindly retry

`GET /reports` and `GET /inbound` are not queries. The spec says each record is
"returned only once" — reading a batch consumes it. Two consequences:

- **Replaying a failed read loses data.** If a request times out after the platform dequeued
  a batch, the replay returns the *next* batch and the first is gone. So neither route is
  replayed on an unknown outcome, even though both are GETs. Opt in per call with
  `replayOnUnknownOutcome` where a lost batch is acceptable.
- **One consumer per account per channel.** Two pollers split the stream between them.

A refusal is different from an unknown outcome: a `429` or `503` means the server did nothing,
so those are retried on every route, including sends. A `500`, `502`, or `504` is ambiguous —
the request may have been processed and only the response lost — so those are not retried on a
send. There is no idempotency key on this API; a blind replay is a second message.

### 3. `validate` answers "invalid" with a 400, and that is a result

`POST /messages/validate` returns 400 with the violations when a payload is bad. That is the
route working, not failing, so `messages.validate()` returns it instead of throwing:

```ts
const result = await client.messages.validate({ messages });
if (!result.valid) {
  for (const violation of result.violations) console.error(violation.property, violation.violation);
}
```

A 401, 429, or 5xx from that route still throws.

### 4. Infobip does not sign its webhooks

The spec declares no signature header and no `security` on any of the three webhook
operations, so there is nothing to verify cryptographically. `@assure-ai/infobip-webhooks`
does not pretend otherwise: it checks the credential *you* attached to the callback URL you
registered — a shared-secret header, Basic auth, or your own predicate. `'none'` is allowed
but has to be written down, so no endpoint ends up unauthenticated by omission.

### 5. Channel support is narrower than the channel list

Each capability has its own channel set, and they differ:

| Capability | Channels |
| --- | --- |
| Send a message | Apple MB, Instagram DM, LINE, Messenger, MMS, RCS, SMS, Viber BM, Viber Bot, WhatsApp |
| Pull inbound messages | Apple MB, Messenger, MMS, SMS, Viber BM, WhatsApp |
| Delivery reports | the send list, plus KAKAO, Zalo, Voice, Telegram |
| Typing started | Apple MB, RCS, WhatsApp |
| Typing stopped | Apple MB |
| Seen event | RCS |

These are in the types, so an unsupported combination is a compile error rather than a 400.

---

## Do I need a tunnel?

Only for what cannot be pulled. Of the three webhooks, one has a pull equivalent and two do not:

| What you want | Pull endpoint | Tunnel needed |
| --- | --- | --- |
| Delivery reports | `GET /reports` — supports every channel including RCS | **No** |
| Inbound messages | `GET /inbound` — but **not** for RCS, RCS is webhook-only | Only for RCS, Instagram, LINE, Viber Bot |
| Seen reports | none — there is no pull route at all | **Yes** |

So a send plus its delivery report is a complete round trip with no public URL. You need a
tunnel only to see a reply on RCS, or a read receipt on any channel.

```bash
npm run integration:webhooks     # listener on :8787, three routes
ngrok http 8787                  # then register the https URL on the account
```

---

## Troubleshooting

### RCS: `EC_UNKNOWN_USER` / `UNDELIVERABLE_REJECTED_OPERATOR`

The platform accepts the send, then the operator rejects it and the delivery report says
*"No matching user found (on platform or on provider)"*.

That wording points at the recipient, but the first thing to check is the **sender**. The
Messages API wants the registered RCS *sender name*, not the RBM **agent id** — passing the
agent id (`something_xxxxxxxx_agent`) is accepted at send time, fails to resolve downstream, and
surfaces as a missing *user*. Confirm the sender by pulling a delivery report for a message you
know arrived:

```ts
const { results } = await client.reports.fetch({ channel: 'RCS', limit: 50 });
// results[].sender is the value that actually worked.
```

Once the sender is right, the genuine recipient-side causes are worth checking in this order:
the number has no RCS profile on its carrier, the device has RCS disabled, or the agent has not
launched with that carrier.

## Development

```bash
npm install
npm run generate     # normalize the vendor spec, regenerate types and unions
npm run build
npm test
npm run typecheck
```

### The spec pipeline

`spec/infobip-messages-api.json` is the vendor document, unmodified. Two scripts run over it
before generation, and both are checked in CI:

- **`scripts/normalize-spec.mjs`** strips the 64-hex content hash Infobip namespaces its schema
  names with — `899caf…708f.MessagesApiRequest` becomes `MessagesApiRequest`. Without it every
  generated type is unnameable, and the hash changes whenever the upstream document is
  regenerated, so diffs churn on identical schemas. It refuses to write if two names collide
  once the prefix is gone.
- **`scripts/generate-unions.mjs`** emits the discriminated unions. `openapi-typescript` gives
  each concrete variant a narrowed literal discriminator but leaves the polymorphic *base* as
  the open parent — `MessagesApiMessageBody` generates as `{ type: MessageBodyType }`, which
  narrows to nothing and completes to nothing. The spec already states the mapping in each
  schema's `discriminator.mapping`; this derives the unions from it rather than hand-writing
  eighteen body variants that would drift on the next content type Infobip adds.

The curated `src/index.ts` then substitutes those unions where the generated schemas reference
the open parents — `MessageContent.body`, `MessageContent.buttons`, `MoEvent.content` — which
is what makes a message literal writable and `switch (body.type)` narrow.

### Live tests

```bash
cp .env.example .env.local     # then fill in INFOBIP_API_KEY
npm run integration:rcs -- --dry-run     # validates only, sends nothing
npm run integration:rcs                  # sends one real message, polls for the report
```

`.env.local` is gitignored. The dry run costs nothing and catches an unregistered sender or a
malformed destination before anything is sent.

## License

MIT
