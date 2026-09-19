/**
 * A local webhook endpoint for the deliveries that cannot be pulled.
 *
 * Serves three routes, one per webhook, each with the right `kind`:
 *
 *   POST /webhooks/delivery   delivery reports
 *   POST /webhooks/seen       seen reports   (RCS: webhook-only, no pull route)
 *   POST /webhooks/inbound    inbound messages (RCS: webhook-only)
 *
 * Infobip has to reach this over the public internet, so put a tunnel in front
 * and register the tunnel's URL on the account:
 *
 *   ngrok http 8787
 *
 * Run: `npm run integration:webhooks`
 */
import { createServer } from 'node:http';
import { WebhookReceiver, type WebhookKind } from '@assure-ai/infobip-webhooks';
import { loadEnv, optional } from './env.ts';

loadEnv();

const port = Number(optional('PORT') ?? 8787);
const secret = optional('INFOBIP_WEBHOOK_SECRET');

if (!secret) {
  console.warn(
    'INFOBIP_WEBHOOK_SECRET is not set, so this listener accepts any caller.\n' +
      'Fine behind a tunnel you are watching; set one before pointing anything real at it.\n',
  );
}

const authorization = secret ? { secret } : ('none' as const);

/** One receiver per route, because the kind is a property of the endpoint. */
const receivers: Record<string, WebhookReceiver> = {
  '/webhooks/delivery': new WebhookReceiver({
    kind: 'delivery-report',
    authorization,
    onDeliveryReports: (results) => {
      for (const report of results) {
        console.log(
          `[delivery] ${report.messageId} ${report.status?.groupName}/${report.status?.name} ` +
            `to ${report.destination} at ${report.doneAt}`,
        );
        if (report.error?.name && report.error.name !== 'NO_ERROR') {
          console.log(`           error ${report.error.name}: ${report.error.description}`);
        }
      }
    },
  }),

  '/webhooks/seen': new WebhookReceiver({
    kind: 'seen-report',
    authorization,
    onSeenReports: (results) => {
      for (const seen of results) {
        console.log(`[seen] ${seen.messageId} seen by ${seen.destination} at ${seen.seenAt}`);
      }
    },
  }),

  '/webhooks/inbound': new WebhookReceiver({
    kind: 'inbound-message',
    authorization,
    onMessage: (message) => {
      const parts = message.content
        .map((part) => (part.type === 'TEXT' ? part.text : `<${part.type}>`))
        .join(' ');
      console.log(`[inbound] ${message.sender ?? 'unknown'} on ${message.channel}: ${parts}`);
    },
    onInboundEvents: (events) => {
      for (const event of events) {
        if (event.event !== 'MO') console.log(`[inbound] ${event.event}`);
      }
    },
  }),
};

const server = createServer((request, response) => {
  void (async () => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const receiver = receivers[path];

    if (request.method !== 'POST' || !receiver) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Not found', routes: Object.keys(receivers) }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    const result = await receiver.handle({ headers: request.headers, body });
    if (result.status !== 200) {
      console.warn(`[${path}] ${result.status} ${JSON.stringify(result.body)}`);
      console.warn(`         body was: ${body.slice(0, 400)}`);
    }

    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  })().catch((error: unknown) => {
    console.error('listener failed', error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  for (const route of Object.keys(receivers)) console.log(`  POST ${route}`);
  console.log(`\nAuthorization: ${secret ? 'x-infobip-webhook-secret must match' : 'none (open)'}`);
  console.log('\nExpose it, then register the public URL on the Infobip account:');
  console.log(`  ngrok http ${port}`);
});
