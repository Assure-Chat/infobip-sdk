# @assure-ai/infobip-types

Types for the [Infobip Messages API](https://www.infobip.com/docs/api/platform/messages-api).

```bash
npm install @assure-ai/infobip-types
```

Three layers, in increasing order of how much a human touched them.

## 1. `@assure-ai/infobip-types/openapi`

Verbatim `openapi-typescript` output — every schema in the document, reachable as
`components['schemas'][…]`, plus `paths`, `operations`, and `webhooks`. Regenerated from the
spec; never edited.

The vendor document namespaces its schema names with a 64-hex content hash
(`899caf…708f.MessagesApiRequest`). The build strips it first, so names here are plain.

## 2. The `…Union` aliases

`openapi-typescript` gives each concrete variant a narrowed literal discriminator, but leaves
the polymorphic *base* as the open parent. `MessagesApiMessageBody` generates as
`{ type: MessageBodyType }` — it narrows to nothing and completes to nothing.

The spec already states the real shape in each schema's `discriminator.mapping`, so these are
derived from it rather than hand-written:

```ts
import type { MessagesApiMessageBodyUnion } from '@assure-ai/infobip-types';
// = MessagesApiMessageTextBody | MessagesApiMessageImageBody | … (18 variants)
```

## 3. The curated surface

Short names for what you actually reach for, with the unions substituted where the generated
schemas point at an open parent — which is what makes a message literal writable:

```ts
import type { MessageBody, OutboundMessage } from '@assure-ai/infobip-types';

const body: MessageBody = { type: 'TEXT', text: 'hello' };
if (body.type === 'IMAGE') body.url;   // narrows
```

### Vocabularies

Exported as runtime values as well as types, because validating a channel at an application
boundary is common enough that every consumer would otherwise retype the list:

```ts
import { OUTBOUND_CHANNELS, INBOUND_PULL_CHANNELS, isOutboundChannel } from '@assure-ai/infobip-types';

isOutboundChannel(input);   // narrows to OutboundChannel
```

`OUTBOUND_CHANNELS`, `INBOUND_PULL_CHANNELS`, `REPORT_CHANNELS`, `MESSAGE_BODY_TYPES`,
`MESSAGE_STATUS_GROUPS`, `TERMINAL_STATUS_GROUPS`, `OUTBOUND_EVENT_TYPES`. Each is checked
against the spec enum it mirrors by a test, so it cannot quietly drift.

### Guards

`isInboundMessage`, `isTerminalStatus`, `isDelivered`, `isMessageStatusGroup`,
`isOutboundChannel`, `isInboundPullChannel`.

`isTerminalStatus` takes a `string` on purpose: a send response types `groupName` as the enum,
while a delivery report types the same field as a bare `string`. The guard absorbs that rather
than making callers cast between two spellings of one idea.

## License

MIT
