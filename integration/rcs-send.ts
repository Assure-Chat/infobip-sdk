/**
 * Live RCS round trip against a real Infobip account.
 *
 * Four stages, each one stopping before the next if it fails:
 *
 * 1. `validate` — the payload is checked by the platform without being sent.
 *    Free, sends nothing, and catches a bad sender or destination up front.
 * 2. `send` — one real RCS message. This costs money and rings a real handset.
 * 3. `reports` — poll the delivery-report queue until the message reaches a
 *    terminal status, or the timeout expires.
 * 4. A short summary of what each stage said.
 *
 * Run: `npm run integration:rcs -- "optional message text"`
 * Add `--dry-run` to stop after stage 1.
 */
import { InfobipClient, isInfobipApiError, isTerminalStatus } from '@assure/infobip-api';
import type { AnyOutboundMessage, DeliveryResult } from '@assure/infobip-api';
import { fingerprint, loadEnv, optional, required } from './env.ts';

loadEnv();

const baseUrl = required('INFOBIP_BASE_URL', 'Your account API host, e.g. https://xxxxx.api.infobip.com');
const apiKey = required('INFOBIP_API_KEY', 'An API key from https://portal.infobip.com/settings/accounts/api-keys');
const sender = required('INFOBIP_RCS_SENDER', 'The registered RCS sender NAME (not the RBM agent id) — see the README');
const to = required('INFOBIP_TEST_MSISDN', 'The destination handset in E.164, e.g. +441134960001');

const dryRun = process.argv.includes('--dry-run');
const text =
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
  `Assure SDK test — ${new Date().toISOString()}`;

const client = new InfobipClient({
  baseUrl,
  apiKey,
  onRequest: ({ method, url, attempt }) => {
    console.log(`  → ${method} ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
  },
  onResponse: ({ status, durationMs }) => {
    console.log(`  ← ${status} in ${durationMs}ms`);
  },
});

console.log('Infobip RCS integration test');
console.log(`  base URL : ${client.baseUrl}`);
console.log(`  API key  : ${fingerprint(apiKey)}`);
console.log(`  sender   : ${sender}`);
console.log(`  to       : ${to}`);
console.log(`  text     : ${text}`);
console.log();

// Infobip takes E.164 without the leading plus on the wire.
const destination = to.replace(/^\+/, '');

const message: AnyOutboundMessage = {
  channel: 'RCS',
  sender,
  destinations: [{ to: destination }],
  content: { body: { type: 'TEXT', text } },
};

// -- 1. validate ------------------------------------------------------------

console.log('1. Validating the payload (nothing is sent)…');
const validation = await client.messages.validate({ messages: [message] }).catch(fail('validate'));

if (!validation.valid) {
  console.error('   ✗ The platform rejected the payload:');
  console.error(`     ${validation.description}`);
  console.error(`     ${validation.action}`);
  for (const violation of validation.violations ?? []) {
    console.error(`     · ${violation.property}: ${violation.violation}`);
  }
  process.exit(1);
}
console.log(`   ✓ ${validation.description}`);
for (const violation of validation.skippableViolations ?? []) {
  console.log(`   ! ${violation.property}: ${violation.violation}`);
}

if (dryRun) {
  console.log('\n--dry-run given; stopping before the send.');
  process.exit(0);
}

// -- 2. send ----------------------------------------------------------------

console.log('\n2. Sending one real RCS message…');
const response = await client.messages.send({ messages: [message] }).catch(fail('send'));

const sent = response.messages[0];
console.log(`   ✓ accepted — bulkId ${response.bulkId}`);
console.log(`     messageId  ${sent?.messageId}`);
console.log(`     status     ${sent?.status?.groupName} / ${sent?.status?.name}`);
if (sent?.status?.description) console.log(`     ${sent.status.description}`);

const messageId = sent?.messageId;
if (messageId === undefined) {
  console.error('   ✗ No messageId came back, so the report cannot be correlated.');
  process.exit(1);
}

// -- 3. delivery reports ----------------------------------------------------

// RCS supports the pull queue for delivery reports, so this needs no webhook
// and no public URL. (Inbound RCS replies are webhook-only — see the README.)
console.log('\n3. Polling the delivery-report queue for that message…');
const deadline = Date.now() + 90_000;
let report: DeliveryResult | undefined;

while (Date.now() < deadline) {
  const batch = await client.reports.fetch({ channel: 'RCS', messageId, limit: 100 }).catch(fail('reports'));
  report = batch.results?.find((result) => result.messageId === messageId);
  if (report && isTerminalStatus(report.status?.groupName)) break;
  if (report) {
    console.log(`   … ${report.status?.groupName} — not terminal yet`);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

if (!report) {
  console.log('   ! No delivery report arrived within 90s.');
  console.log('     The message may still be in flight, or another poller drained the queue —');
  console.log('     the report queue hands each record out only once.');
  process.exit(0);
}

console.log(`   ✓ ${report.status?.groupName} / ${report.status?.name}`);
console.log(`     sentAt ${report.sentAt}   doneAt ${report.doneAt}`);
if (report.error?.name && report.error.name !== 'NO_ERROR') {
  console.log(`     error  ${report.error.name} — ${report.error.description}`);
}

console.log('\nDone.');

/** Print an API failure in full, then exit. */
function fail(stage: string): (error: unknown) => never {
  return (error: unknown) => {
    console.error(`   ✗ ${stage} failed`);
    if (isInfobipApiError(error)) {
      console.error(`     HTTP ${error.status}${error.code ? ` (${error.code})` : ''}`);
      console.error(`     ${error.message}`);
      if (error.action) console.error(`     action: ${error.action}`);
      for (const violation of error.violations ?? []) {
        console.error(`     · ${violation.property}: ${violation.violation}`);
      }
    } else {
      console.error(`     ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  };
}
