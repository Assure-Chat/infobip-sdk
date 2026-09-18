import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  INBOUND_PULL_CHANNELS,
  MESSAGE_BODY_TYPES,
  OUTBOUND_CHANNELS,
  REPORT_CHANNELS,
  isDelivered,
  isInboundMessage,
  isInboundPullChannel,
  isOutboundChannel,
  isTerminalStatus,
  type InboundEvent,
  type MessageBody,
} from '../src/index.js';
import specDocument from '../../../spec/infobip-messages-api.normalized.json' with { type: 'json' };

const schemas = (specDocument as { components: { schemas: Record<string, { enum?: string[] }> } })
  .components.schemas;

describe('vocabularies match the spec', () => {
  // These are hand-written runtime arrays, so they can drift from the schema
  // they mirror. Each one is checked against the spec it was copied from.
  it.each([
    ['OutboundMessageChannel', OUTBOUND_CHANNELS],
    ['InboundMoGetEndpointChannel', INBOUND_PULL_CHANNELS],
    ['InboundDlrChannel', REPORT_CHANNELS],
    ['MessagesApiMessageBodyType', MESSAGE_BODY_TYPES],
  ])('%s', (schemaName, values) => {
    expect([...values].sort()).toEqual([...(schemas[schemaName]?.enum ?? [])].sort());
  });

  it('keeps the inbound pull channels a subset of the send channels', () => {
    for (const channel of INBOUND_PULL_CHANNELS) {
      expect(OUTBOUND_CHANNELS).toContain(channel);
    }
  });
});

describe('guards', () => {
  it('narrows an inbound event to a received message', () => {
    const event = { event: 'MO', channel: 'WHATSAPP', content: [] } as unknown as InboundEvent;
    expect(isInboundMessage(event)).toBe(true);
    expect(isInboundMessage({ event: 'TYPING_STARTED' } as unknown as InboundEvent)).toBe(false);
  });

  it('reports which status groups are final', () => {
    expect(isTerminalStatus('DELIVERED')).toBe(true);
    expect(isTerminalStatus('REJECTED')).toBe(true);
    expect(isTerminalStatus('PENDING')).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it('reads delivery off a status object', () => {
    expect(isDelivered({ groupName: 'DELIVERED' })).toBe(true);
    expect(isDelivered({ groupName: 'EXPIRED' })).toBe(false);
    expect(isDelivered(undefined)).toBe(false);
  });

  it('validates channel strings at a boundary', () => {
    expect(isOutboundChannel('WHATSAPP')).toBe(true);
    expect(isOutboundChannel('CARRIER_PIGEON')).toBe(false);
    expect(isOutboundChannel(42)).toBe(false);
    // Reports arrive for channels you cannot send over via this API.
    expect(isOutboundChannel('TELEGRAM')).toBe(false);
    expect(REPORT_CHANNELS).toContain('TELEGRAM');
    // Not every send channel offers a pull queue.
    expect(isInboundPullChannel('RCS')).toBe(false);
    expect(isInboundPullChannel('WHATSAPP')).toBe(true);
  });
});

describe('message body union', () => {
  it('narrows on the type discriminator', () => {
    const body: MessageBody = { type: 'TEXT', text: 'hello' };
    if (body.type === 'TEXT') {
      expectTypeOf(body.text).toEqualTypeOf<string>();
    }

    const image: MessageBody = { type: 'IMAGE', url: 'https://example.test/a.png' };
    if (image.type === 'IMAGE') {
      expectTypeOf(image.url).toEqualTypeOf<string>();
    }
  });

  it('covers every body type the spec lists', () => {
    // A body of each type must be assignable, which fails to compile if the
    // generated union loses a variant.
    const bodies: MessageBody[] = [
      { type: 'TEXT', text: 'hi' },
      { type: 'IMAGE', url: 'https://example.test/a.png' },
      { type: 'AUTHENTICATION_REQUEST', text: 'Confirm it is you' },
      { type: 'LOCATION', latitude: 0, longitude: 0 },
    ];
    expect(bodies).toHaveLength(4);
  });
});
