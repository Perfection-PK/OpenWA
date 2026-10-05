import { ConfigService } from '@nestjs/config';
import { LeadService, LEAD_SAVED_EVENT, MAX_LEAD_MESSAGES, MAX_LIVE_HISTORY } from './lead.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import type { MessageService } from '../message/message.service';
import type { WebhookService } from '../webhook/webhook.service';
import type { ContactService } from '../contact/contact.service';
import type { Webhook } from '../webhook/entities/webhook.entity';
import type { LeadMessage } from './lead.service';

/** The `data` argument LeadService hands to WebhookService.dispatch. */
type LeadPayload = Record<string, unknown> & { messages: LeadMessage[] };

const CHAT = '628111@c.us';

function row(i: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `row-${i}`,
    sessionId: 's1',
    waMessageId: `wa-${i}`,
    chatId: CHAT,
    chatName: 'Alice',
    from: CHAT,
    to: 'me@c.us',
    body: `message ${i}`,
    type: 'text',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: 1_700_000_000 + i,
    metadata: {},
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    ...overrides,
  };
}

/** A newest-first store of `count` rows, paged the way MessageService.getMessages pages it. */
function storeOf(count: number, make: (i: number) => Message = row) {
  const rows = Array.from({ length: count }, (_, i) => make(count - 1 - i));
  return jest.fn((_session: string, opts: { limit?: number; after?: string }) => {
    const start = opts.after ? rows.findIndex(r => r.id === opts.after) + 1 : 0;
    return Promise.resolve({ messages: rows.slice(start, start + (opts.limit ?? 50)), total: rows.length });
  });
}

function webhook(events: string[], active = true): Webhook {
  return { id: `wh-${events.join()}`, events, active } as Webhook;
}

function build(opts: {
  getMessages: jest.Mock;
  webhooks?: Webhook[];
  resolvePhone?: jest.Mock;
  getChatHistory?: jest.Mock;
  maxPayloadBytes?: number;
}) {
  const dispatch = jest.fn<Promise<void>, [string, string, LeadPayload]>().mockResolvedValue(undefined);
  const service = new LeadService(
    {
      getMessages: opts.getMessages,
      getChatHistory: opts.getChatHistory ?? jest.fn().mockResolvedValue([]),
    } as unknown as MessageService,
    {
      findBySession: jest.fn().mockResolvedValue(opts.webhooks ?? [webhook([LEAD_SAVED_EVENT])]),
      dispatch,
    } as unknown as WebhookService,
    { resolveContactPhone: opts.resolvePhone ?? jest.fn() } as unknown as ContactService,
    {
      get: (key: string, fallback: unknown) =>
        key === 'webhook.maxPayloadBytes' && opts.maxPayloadBytes ? opts.maxPayloadBytes : fallback,
    } as unknown as ConfigService,
  );
  return { service, dispatch };
}

describe('LeadService', () => {
  it('sends name, phone, chat id and the whole thread oldest-first to lead.saved webhooks', async () => {
    const { service, dispatch } = build({ getMessages: storeOf(250) });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result).toEqual({ webhooks: 1, messageCount: 250, totalMessages: 250, truncated: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [sessionId, event, data] = dispatch.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(event).toBe(LEAD_SAVED_EVENT);
    expect(data).toMatchObject({ chatId: CHAT, name: 'Alice', phone: '628111', isGroup: false, truncated: false });
    expect(data.messages.map(m => m.id).slice(0, 2)).toEqual(['wa-0', 'wa-1']);
    expect(data.messages[249].id).toBe('wa-249');
  });

  it('reads stored rows without inline media', async () => {
    const getMessages = storeOf(3);
    const { service } = build({ getMessages });
    await service.saveLead('s1', CHAT, {});
    expect(getMessages).toHaveBeenCalledWith('s1', expect.objectContaining({ chatId: CHAT, inlineMedia: false }));
  });

  it('prefers the operator-supplied name and resolves an @lid phone through the engine', async () => {
    const resolvePhone = jest.fn().mockResolvedValue('628999');
    const { service, dispatch } = build({ getMessages: storeOf(1), resolvePhone });

    await service.saveLead('s1', '12345@lid', { name: 'Bob (VIP)', phone: 'ignored' });

    expect(resolvePhone).toHaveBeenCalledWith('s1', '12345@lid');
    expect(dispatch.mock.calls[0][2]).toMatchObject({ name: 'Bob (VIP)', phone: '628999' });
  });

  it('falls back to the phone hint when an @lid cannot be resolved', async () => {
    const resolvePhone = jest.fn().mockRejectedValue(new Error('page died'));
    const { service, dispatch } = build({ getMessages: storeOf(1), resolvePhone });

    await service.saveLead('s1', '12345@lid', { phone: '+62 811' });

    expect(dispatch.mock.calls[0][2]).toMatchObject({ phone: '+62 811' });
  });

  it('dispatches nothing and reports 0 when no active webhook listens for lead.saved', async () => {
    const { service, dispatch } = build({
      getMessages: storeOf(2),
      webhooks: [webhook(['message.received']), webhook([LEAD_SAVED_EVENT], false)],
    });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result.webhooks).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('counts a wildcard webhook as a subscriber', async () => {
    const { service } = build({ getMessages: storeOf(1), webhooks: [webhook(['*'])] });
    expect((await service.saveLead('s1', CHAT, {})).webhooks).toBe(1);
  });

  it('drops the oldest messages to stay under the webhook payload cap', async () => {
    const big = (i: number) => row(i, { body: 'x'.repeat(1000) });
    const { service, dispatch } = build({ getMessages: storeOf(100, big), maxPayloadBytes: 40 * 1024 });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result.truncated).toBe(true);
    expect(result.messageCount).toBeLessThan(100);
    expect(result.messageCount).toBeGreaterThan(0);
    const data = dispatch.mock.calls[0][2];
    // The newest message is always kept.
    expect(data.messages[data.messages.length - 1].id).toBe('wa-99');
    const envelope = {
      event: LEAD_SAVED_EVENT,
      timestamp: '',
      sessionId: 's1',
      idempotencyKey: '',
      deliveryId: '',
      data,
    };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(40 * 1024);
  });

  it('stops reading at the per-lead message ceiling', async () => {
    const getMessages = storeOf(MAX_LEAD_MESSAGES + 150);
    const { service } = build({ getMessages, maxPayloadBytes: 64 * 1024 * 1024 });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result.messageCount).toBe(MAX_LEAD_MESSAGES);
    expect(result.totalMessages).toBe(MAX_LEAD_MESSAGES + 150);
    expect(result.truncated).toBe(true);
  });

  it('reads the live history deeply and merges it with the stored thread, oldest first', async () => {
    const live = (i: number, fromMe = false) => ({
      id: `wa-${i}`,
      from: fromMe ? 'me@c.us' : CHAT,
      to: fromMe ? CHAT : 'me@c.us',
      chatId: CHAT,
      body: `live ${i}`,
      type: 'text',
      timestamp: 1_700_000_000 + i,
      fromMe,
      isGroup: false,
      kind: 'chat',
      contact: { name: 'Alice Live' },
    });
    // Older history the store never captured, plus wa-1 which is also stored.
    const getChatHistory = jest.fn().mockResolvedValue([live(-2), live(-1, true), live(1)]);
    const { service, dispatch } = build({ getMessages: storeOf(2), getChatHistory });

    const result = await service.saveLead('s1', CHAT, {});

    expect(getChatHistory).toHaveBeenCalledWith('s1', CHAT, MAX_LIVE_HISTORY, false, true);
    expect(result).toMatchObject({ messageCount: 4, totalMessages: 4, truncated: false });
    const data = dispatch.mock.calls[0][2];
    expect(data.messages.map(m => m.id)).toEqual(['wa--2', 'wa--1', 'wa-0', 'wa-1']);
    // The stored copy wins on a shared id: it carries the status.
    expect(data.messages[3]).toMatchObject({ body: 'message 1', status: MessageStatus.DELIVERED });
    expect(data.messages[1]).toMatchObject({ fromMe: true, direction: MessageDirection.OUTGOING, status: null });
  });

  it('names the lead from the live history when nothing is stored', async () => {
    const getChatHistory = jest.fn().mockResolvedValue([
      {
        id: 'h1',
        from: CHAT,
        to: 'me@c.us',
        chatId: CHAT,
        body: 'hi',
        type: 'text',
        timestamp: 1,
        fromMe: false,
        isGroup: false,
        kind: 'chat',
        contact: { pushName: 'Pushy' },
      },
    ]);
    const { service, dispatch } = build({ getMessages: storeOf(0), getChatHistory });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result.messageCount).toBe(1);
    expect(dispatch.mock.calls[0][2]).toMatchObject({ name: 'Pushy' });
  });

  it('falls back to the stored thread when the live history fails', async () => {
    const getChatHistory = jest.fn().mockRejectedValue(new Error('session not ready'));
    const { service } = build({ getMessages: storeOf(3), getChatHistory });

    const result = await service.saveLead('s1', CHAT, {});

    expect(result).toMatchObject({ messageCount: 3, totalMessages: 3 });
  });
});
