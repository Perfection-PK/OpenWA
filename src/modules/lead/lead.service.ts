import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { MessageService } from '../message/message.service';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { WebhookService } from '../webhook/webhook.service';
import { ContactService } from '../contact/contact.service';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import type { SaveLeadDto, SaveLeadResponseDto } from './dto/save-lead.dto';

export const LEAD_SAVED_EVENT = 'lead.saved';

/** Ceiling on the messages one lead reads from the store, so a years-long chat cannot pin the request. */
export const MAX_LEAD_MESSAGES = 5000;

/**
 * Messages asked of the engine's live history. getChatHistory clamps a deep read to 2000 (and
 * whatsapp-web.js loads earlier messages on demand to reach it).
 */
export const MAX_LIVE_HISTORY = 2000;

/** The page size getMessages clamps to. */
const PAGE_SIZE = 100;

/** Headroom under the webhook body cap for the envelope (event, ids, timestamps) around `data`. */
const ENVELOPE_HEADROOM_BYTES = 8 * 1024;

/** Mirrors DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES in webhook-delivery.service. */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface LeadMessage {
  id: string;
  direction: MessageDirection;
  fromMe: boolean;
  from: string;
  author: string | null;
  senderName: string | null;
  type: string;
  body: string | null;
  mediaMimetype: string | null;
  /** Null for a message read from live history, which carries no delivery status. */
  status: string | null;
  timestamp: number | null;
  createdAt: string;
}

/**
 * Collects a chat as a "lead" (name, phone, chat id and its thread) and hands it to the
 * webhook pipeline as a `lead.saved` event, so signing, retries, the outbox and the SSRF guard all
 * apply exactly as they do to the engine-produced events.
 */
@Injectable()
export class LeadService {
  private readonly logger = createLogger('LeadService');

  constructor(
    private readonly messageService: MessageService,
    private readonly webhookService: WebhookService,
    private readonly contactService: ContactService,
    private readonly configService: ConfigService,
  ) {}

  async saveLead(sessionId: string, chatId: string, dto: SaveLeadDto): Promise<SaveLeadResponseDto> {
    const [{ messages: stored, total: storedTotal }, live] = await Promise.all([
      this.readThread(sessionId, chatId),
      this.readLiveHistory(sessionId, chatId),
    ]);
    const phone = (await this.derivePhone(sessionId, chatId)) ?? (dto.phone?.trim() || null);
    const liveSender = live.find(m => !m.fromMe)?.contact;
    const name =
      dto.name?.trim() ||
      stored.find(m => m.direction === MessageDirection.INCOMING)?.chatName ||
      liveSender?.name ||
      liveSender?.pushName ||
      null;

    // The store only holds what the gateway captured since the session was linked, so the live
    // history fills in the older thread. A stored row wins on a shared id: it carries the status.
    const byId = new Map<string, LeadMessage>();
    for (const m of live) byId.set(m.id, fromHistory(m));
    for (const m of stored) {
      const lead = toLeadMessage(m);
      byId.set(lead.id, lead);
    }
    // Oldest first, like a transcript.
    const all = [...byId.values()].sort((a, b) => sortKey(a) - sortKey(b));
    // Stored rows beyond the read ceiling were never merged, so they still count toward the total.
    const total = all.length + Math.max(0, storedTotal - stored.length);
    const base = {
      sessionId,
      chatId,
      name,
      phone,
      isGroup: chatId.endsWith('@g.us'),
      savedAt: new Date().toISOString(),
      totalMessages: total,
    };
    const messages = this.fitToPayloadCap(base, all);
    const truncated = messages.length < total;

    const subscribers = (await this.webhookService.findBySession(sessionId)).filter(
      w => w.active && (w.events.includes(LEAD_SAVED_EVENT) || w.events.includes('*')),
    );
    if (subscribers.length > 0) {
      // Fire-and-forget like every other producer: delivery is queued and retried on its own.
      void this.webhookService.dispatch(sessionId, LEAD_SAVED_EVENT, {
        ...base,
        truncated,
        messageCount: messages.length,
        messages,
      });
    }

    return { webhooks: subscribers.length, messageCount: messages.length, totalMessages: total, truncated };
  }

  /**
   * The chat read live from WhatsApp, oldest first. Best-effort: a session that is not ready, an
   * engine without history support or a dead page leaves the lead with the stored thread alone.
   */
  private async readLiveHistory(sessionId: string, chatId: string): Promise<IncomingMessage[]> {
    try {
      return await this.messageService.getChatHistory(sessionId, chatId, MAX_LIVE_HISTORY, false, true);
    } catch (error) {
      this.logger.warn(`Live history unavailable for lead ${chatId}; sending stored messages only`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Walks the stored thread newest-first by keyset cursor, up to MAX_LEAD_MESSAGES rows. */
  private async readThread(sessionId: string, chatId: string): Promise<{ messages: Message[]; total: number }> {
    const messages: Message[] = [];
    let total = 0;
    let after: string | undefined;
    while (messages.length < MAX_LEAD_MESSAGES) {
      const page = await this.messageService.getMessages(sessionId, {
        chatId,
        limit: PAGE_SIZE,
        after,
        inlineMedia: false,
      });
      total = page.total;
      messages.push(...page.messages);
      if (page.messages.length < PAGE_SIZE) break;
      after = page.messages[page.messages.length - 1].id;
    }
    return { messages: messages.slice(0, MAX_LEAD_MESSAGES), total };
  }

  /**
   * The phone behind a 1:1 chat id: the user part of a `@c.us` / `@s.whatsapp.net` id, or the
   * engine's best-effort mapping of an `@lid` (whose digits are NOT a phone). Groups have none.
   */
  private async derivePhone(sessionId: string, chatId: string): Promise<string | null> {
    const match = /^(\d+)(?::\d+)?@(c\.us|s\.whatsapp\.net)$/.exec(chatId);
    if (match) return match[1];
    if (!chatId.endsWith('@lid')) return null;
    try {
      return await this.contactService.resolveContactPhone(sessionId, chatId);
    } catch (error) {
      this.logger.debug(`Lead phone lookup failed for ${chatId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Keeps the newest messages that fit under the webhook body cap. An over-cap body is recorded as
   * undelivered rather than sent, so a long chat must be trimmed here instead of failing outright.
   */
  private fitToPayloadCap(base: Record<string, unknown>, messages: LeadMessage[]): LeadMessage[] {
    const cap = this.configService.get<number>('webhook.maxPayloadBytes', DEFAULT_MAX_PAYLOAD_BYTES);
    const budget =
      cap -
      ENVELOPE_HEADROOM_BYTES -
      byteLength({ ...base, truncated: true, messageCount: messages.length, messages: [] });
    let used = 0;
    let start = messages.length;
    while (start > 0) {
      // +1 for the separating comma.
      const size = byteLength(messages[start - 1]) + 1;
      if (used + size > budget) break;
      used += size;
      start--;
    }
    return messages.slice(start);
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sortKey(m: LeadMessage): number {
  return m.timestamp != null ? m.timestamp * 1000 : Date.parse(m.createdAt);
}

function fromHistory(m: IncomingMessage): LeadMessage {
  return {
    id: m.id,
    direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
    fromMe: m.fromMe,
    from: m.from,
    author: m.author ?? null,
    senderName: m.fromMe ? null : (m.contact?.name ?? m.contact?.pushName ?? null),
    type: m.type,
    body: m.body || null,
    mediaMimetype: m.media?.mimetype ?? null,
    status: null,
    timestamp: m.timestamp ?? null,
    createdAt: new Date((m.timestamp ?? 0) * 1000).toISOString(),
  };
}

function toLeadMessage(m: Message): LeadMessage {
  return {
    id: m.waMessageId ?? m.id,
    direction: m.direction,
    fromMe: m.direction === MessageDirection.OUTGOING,
    from: m.from,
    author: m.author ?? null,
    senderName: m.chatName ?? null,
    type: m.type,
    body: m.body ?? null,
    mediaMimetype: m.mediaMimetype ?? null,
    status: m.status,
    timestamp: m.timestamp ?? null,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}
