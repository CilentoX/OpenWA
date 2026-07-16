import { EventEmitter } from 'events';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import {
  GroupChat,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      // Clear SingletonLock if it exists to prevent Chromium from crashing on boot (profile in use error)
      const sessionDir = path.join(path.resolve(this.config.sessionDataPath), `session-${this.config.sessionId}`);
      const correctSessionDir = path.join(path.resolve(this.config.sessionDataPath), '.wwebjs_auth', `session-${this.config.sessionId}`);
      const lockFiles = [
        path.join(sessionDir, 'Default', 'SingletonLock'),
        path.join(correctSessionDir, 'Default', 'SingletonLock'),
      ];
      
      for (const lockFile of lockFiles) {
        try {
          if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            this.logger.log(`Cleaned up stale SingletonLock at: ${lockFile}`);
          }
        } catch (err) {
          this.logger.error(`Failed to clean up SingletonLock at ${lockFile}: ${err.message}`);
        }
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage: IncomingMessage = {
          id: msg.id._serialized,
          from: msg.from,
          to: msg.to,
          chatId: msg.from,
          body: msg.body,
          type: msg.type,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          isGroup: msg.from.endsWith('@g.us'),
        };

        // Handle media
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            this.logger.error('Error downloading media', String(error));
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const msg = await this.client!.sendMessage(chatId, text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      caption: media.caption,
    });

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
      };
    });
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.client!.sendMessage(chatId, loc);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.client!.sendMessage(chatId, vcard, {
      parseVCards: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error('Chat is not a group');\n    }\n    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));\n    await (chat as unknown as GroupChat).demoteParticipants(participantIds);\n  }\n\n  async leaveGroup(groupId: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error('Chat is not a group');\n    }\n    await (chat as unknown as GroupChat).leave();\n  }\n\n  async setGroupSubject(groupId: string, subject: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error('Chat is not a group');\n    }\n    await (chat as unknown as GroupChat).setSubject(subject);\n  }\n\n  async setGroupDescription(groupId: string, description: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error('Chat is not a group');\n    }\n    await (chat as unknown as GroupChat).setDescription(description);\n  }\n\n  // Reactions (Phase 3)\n  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    const messages = await chat.fetchMessages({ limit: 100 });\n    const message = messages.find(m => m.id._serialized === messageId);\n    if (!message) {\n      throw new Error(`Message ${messageId} not found in chat ${chatId}`);\n    }\n    await (message as MessageWithReactions).react(emoji);\n    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);\n  }\n\n  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    const messages = await chat.fetchMessages({ limit: 100 });\n    const message = messages.find(m => m.id._serialized === messageId);\n    if (!message) {\n      throw new Error(`Message ${messageId} not found in chat ${chatId}`);\n    }\n    const msgWithReactions = message as MessageWithReactions;\n    if (!msgWithReactions.hasReaction) {\n      return [];\n    }\n    const reactions = await msgWithReactions.getReactions();\n    if (!reactions) {\n      return [];\n    }\n    // Map reactions to our interface format\n    const result: MessageReaction[] = [];\n\n    for (const r of reactions) {\n      result.push({\n        emoji: String(r.id),\n        senders: (r.senders || []).map(s => ({\n          senderId: String(s.senderId),\n          emoji: String(s.reaction),\n          timestamp: Number(s.timestamp),\n        })),\n      });\n    }\n    return result;\n  }\n\n  // Labels (Phase 3) - WhatsApp Business only\n  async getLabels(): Promise<Label[]> {\n    this.ensureReady();\n    const labels = await (this.client as unknown as BusinessClient).getLabels();\n    if (!labels) {\n      return [];\n    }\n\n    return labels.map(label => ({\n      id: String(label.id),\n      name: String(label.name),\n      hexColor: String(label.hexColor),\n    }));\n  }\n\n  async getLabelById(labelId: string): Promise<Label | null> {\n    this.ensureReady();\n    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);\n    if (!label) {\n      return null;\n    }\n    return {\n      id: String(label.id),\n      name: String(label.name),\n      hexColor: String(label.hexColor),\n    };\n  }\n\n  async getChatLabels(chatId: string): Promise<Label[]> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    const labels = await (chat as unknown as GroupChat).getLabels();\n    if (!labels) {\n      return [];\n    }\n\n    return labels.map(label => ({\n      id: String(label.id),\n      name: String(label.name),\n      hexColor: String(label.hexColor),\n    }));\n  }\n\n  async addLabelToChat(chatId: string, labelId: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    await (chat as unknown as GroupChat).addLabel(labelId);\n    this.logger.log(`Added label ${labelId} to chat ${chatId}`);\n  }\n\n  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    await (chat as unknown as GroupChat).removeLabel(labelId);\n    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);\n  }\n\n  // Channels/Newsletter (Phase 3)\n  async getSubscribedChannels(): Promise<Channel[]> {\n    this.ensureReady();\n    const channels = await (this.client as unknown as BusinessClient).getChannels();\n    if (!channels) {\n      return [];\n    }\n    return channels.map((ch: WwjsChannelData) => ({\n      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),\n      name: String(ch.name || ''),\n      description: ch.description ? String(ch.description) : undefined,\n      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,\n      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,\n      verified: ch.verified ? Boolean(ch.verified) : undefined,\n    }));\n  }\n\n  async getChannelById(channelId: string): Promise<Channel | null> {\n    this.ensureReady();\n    try {\n      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);\n      if (!ch) {\n        return null;\n      }\n      return {\n        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),\n        name: String(ch.name || ''),\n        description: ch.description ? String(ch.description) : undefined,\n        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,\n        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,\n        verified: ch.verified ? Boolean(ch.verified) : undefined,\n      };\n    } catch (error) {\n      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));\n      return null;\n    }\n  }\n\n  async subscribeToChannel(inviteCode: string): Promise<Channel> {\n    this.ensureReady();\n    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);\n    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);\n    return {\n      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),\n      name: String(ch.name || ''),\n      description: ch.description ? String(ch.description) : undefined,\n    };\n  }\n\n  async unsubscribeFromChannel(channelId: string): Promise<void> {\n    this.ensureReady();\n    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);\n    this.logger.log(`Unsubscribed from channel: ${channelId}`);\n  }\n\n  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {\n    this.ensureReady();\n    try {\n      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);\n      if (!ch) {\n        throw new Error(`Channel ${channelId} not found`);\n      }\n      const messages = await ch.fetchMessages({ limit });\n      if (!messages) {\n        return [];\n      }\n      return messages.map(msg => ({\n        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),\n        body: String(msg.body || ''),\n        timestamp: Number(msg.timestamp),\n        hasMedia: Boolean(msg.hasMedia),\n        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,\n      }));\n    } catch (error) {\n      this.logger.error(`Failed to get channel messages: ${String(error)}`);\n      return [];\n    }\n  }\n\n  // ========== Gap Quick Wins Implementation ==========\n\n  // Delete Message\n  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(chatId);\n    const messages = await chat.fetchMessages({ limit: 100 });\n    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);\n    if (!message) {\n      throw new Error(`Message ${messageId} not found in chat ${chatId}`);\n    }\n    await message.delete(forEveryone);\n    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);\n  }\n\n  // Get Profile Picture\n  async getProfilePicture(contactId: string): Promise<string | null> {\n    this.ensureReady();\n    try {\n      const url = await this.client!.getProfilePicUrl(contactId);\n      return url || null;\n    } catch (error) {\n      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);\n      return null;\n    }\n  }\n\n  // Block Contact\n  async blockContact(contactId: string): Promise<void> {\n    this.ensureReady();\n    const contact = await this.client!.getContactById(contactId);\n    await contact.block();\n    this.logger.log(`Blocked contact ${contactId}`);\n  }\n\n  // Unblock Contact\n  async unblockContact(contactId: string): Promise<void> {\n    this.ensureReady();\n    const contact = await this.client!.getContactById(contactId);\n    await contact.unblock();\n    this.logger.log(`Unblocked contact ${contactId}`);\n  }\n\n  // Get Group Invite Code\n  async getGroupInviteCode(groupId: string): Promise<string> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error(`${groupId} is not a group`);\n    }\n    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();\n    this.logger.log(`Got invite code for group ${groupId}`);\n    return String(inviteCode);\n  }\n\n  // Revoke Group Invite Code\n  async revokeGroupInviteCode(groupId: string): Promise<string> {\n    this.ensureReady();\n    const chat = await this.client!.getChatById(groupId);\n    if (!chat.isGroup) {\n      throw new Error(`${groupId} is not a group`);\n    }\n    const newCode = await (chat as unknown as GroupChat).revokeInvite();\n    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);\n    return String(newCode);\n  }\n\n  // ========== Status/Stories (Phase 3) ==========\n  // Note: These are stub implementations - whatsapp-web.js has limited Status API support\n  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */\n\n  async getContactStatuses(): Promise<Status[]> {\n    this.ensureReady();\n    // whatsapp-web.js has limited Status API support\n    // This is a stub that can be enhanced when the library adds support\n    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');\n    return [];\n  }\n\n  async getContactStatus(_contactId: string): Promise<Status[]> {\n    this.ensureReady();\n    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');\n    return [];\n  }\n\n  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {\n    this.ensureReady();\n    // whatsapp-web.js doesn't have native status posting\n    // This would require using the underlying WhatsApp Web API directly\n    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');\n  }\n\n  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {\n    this.ensureReady();\n    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');\n  }\n\n  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {\n    this.ensureReady();\n    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');\n  }\n\n  async deleteStatus(_statusId: string): Promise<void> {\n    this.ensureReady();\n    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');\n  }\n\n  // ========== Catalog (Phase 3) ==========\n\n  async getCatalog(): Promise<Catalog | null> {\n    this.ensureReady();\n    // whatsapp-web.js doesn't have native Catalog API support\n    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');\n    return null;\n  }\n\n  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {\n    this.ensureReady();\n    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');\n    return {\n      products: [],\n      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },\n    };\n  }\n\n  async getProduct(_productId: string): Promise<Product | null> {\n    this.ensureReady();\n    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');\n    return null;\n  }\n\n  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {\n    this.ensureReady();\n    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');\n  }\n\n  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {\n    this.ensureReady();\n    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');\n  }\n\n  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */\n\n  private ensureReady(): void {\n    if (this.status !== EngineStatus.READY || !this.client) {\n      throw new Error('WhatsApp client is not ready');\n    }\n  }\n}\n