import { EventEmitter } from 'events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  WAMessage,
  GroupMetadata,
} from '@whiskeysockets/baileys';
import * as pino from 'pino';
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

export interface BaileysConfig {
  sessionId: string;
  sessionDataPath: string;
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

export class BaileysAdapter extends EventEmitter implements IWhatsAppEngine {
  private sock: any = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isExplicitDisconnect = false;

  private readonly logger = createLogger('BaileysAdapter');

  constructor(private readonly config: BaileysConfig) {
    super();
  }

  private formatChatId(chatId: string): string {
    if (!chatId || typeof chatId !== 'string') return chatId;
    let clean = chatId.trim();
    if (clean.includes('@g.us')) return clean;
    if (clean.includes('@s.whatsapp.net')) return clean;
    if (clean.includes('@c.us')) {
      return clean.replace('@c.us', '@s.whatsapp.net');
    }
    const numbers = clean.replace(/\D/g, '');
    return `${numbers}@s.whatsapp.net`;
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.isExplicitDisconnect = false;
    this.setStatus(EngineStatus.INITIALIZING);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const sessionDir = path.join(
        path.resolve(this.config.sessionDataPath),
        'baileys_auth',
        `session-${this.config.sessionId}`,
      );

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      let version: [number, number, number] = [2, 3000, 1015901307];
      try {
        const vInfo = await fetchLatestBaileysVersion();
        version = vInfo.version;
      } catch (err) {
        this.logger.warn(`Could not fetch latest Baileys version, using default: ${String(err)}`);
      }

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }) as any,
        printQRInTerminal: false,
        browser: ['OpenWA Gateway', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCode = await qrcode.toDataURL(qr, { margin: 2, scale: 6 });
            this.setStatus(EngineStatus.QR_READY);
            this.callbacks.onQRCode?.(this.qrCode);
          } catch (err) {
            this.logger.error('Error generating QR code', String(err));
          }
        }

        if (connection === 'open') {
          const user = sock.user;
          this.phoneNumber = user?.id ? user.id.split(':')[0].split('@')[0] : null;
          this.pushName = user?.name || user?.notify || null;
          this.qrCode = null;

          this.setStatus(EngineStatus.READY);
          this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
          this.logger.log(`Session connected: ${this.config.sessionId} (Phone: ${this.phoneNumber})`);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect =
            !this.isExplicitDisconnect && statusCode !== DisconnectReason.loggedOut;

          this.logger.warn(
            `Session connection closed (${this.config.sessionId}). Status: ${statusCode}, Reconnect: ${shouldReconnect}`,
          );

          if (shouldReconnect) {
            this.setStatus(EngineStatus.INITIALIZING);
            this.reconnectTimer = setTimeout(() => {
              this.initialize(this.callbacks).catch(e => {
                this.logger.error(`Reconnect failed: ${String(e)}`);
              });
            }, 3500);
          } else {
            this.sock = null;
            this.setStatus(EngineStatus.DISCONNECTED);
            this.callbacks.onDisconnected?.(
              statusCode === DisconnectReason.loggedOut ? 'Logged out' : 'Connection closed',
            );
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !Array.isArray(messages)) return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const from = msg.key.remoteJid;
          if (!from || from === 'status@broadcast') continue;

          const isGroup = from.endsWith('@g.us');
          const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            '';

          const incomingMessage: IncomingMessage = {
            id: msg.key.id || '',
            from: from.replace('@s.whatsapp.net', '@c.us'),
            to: (sock.user?.id || '').split(':')[0] + '@c.us',
            chatId: from.replace('@s.whatsapp.net', '@c.us'),
            body: body.trim(),
            type: msg.message.imageMessage
              ? 'image'
              : msg.message.videoMessage
                ? 'video'
                : msg.message.audioMessage
                  ? 'audio'
                  : msg.message.documentMessage
                    ? 'document'
                    : 'chat',
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            fromMe: Boolean(msg.key.fromMe),
            isGroup,
          };

          this.callbacks.onMessage?.(incomingMessage);
        }
      });
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  async disconnect(): Promise<void> {
    this.isExplicitDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (err) {
        this.logger.warn(`Disconnect failed: ${String(err)}`);
      }
      this.sock = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    this.isExplicitDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (err) {
        this.logger.warn(`Logout failed: ${String(err)}`);
      }
      this.sock = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    const sessionDir = path.join(
      path.resolve(this.config.sessionDataPath),
      'baileys_auth',
      `session-${this.config.sessionId}`,
    );
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  async destroy(): Promise<void> {
    await this.disconnect();
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

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new Error('WhatsApp client is not ready');
    }
  }

  private async parseMediaBuffer(media: MediaInput): Promise<Buffer> {
    if (Buffer.isBuffer(media.data)) {
      return media.data;
    }
    if (typeof media.data === 'string') {
      if (media.data.startsWith('data:')) {
        const base64Data = media.data.split(',')[1];
        return Buffer.from(base64Data, 'base64');
      }
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        const res = await fetch(media.data);
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
      return Buffer.from(media.data, 'base64');
    }
    throw new Error('Formato de mídia inválido.');
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const result = await this.sock.sendMessage(targetChat, { text });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const buffer = await this.parseMediaBuffer(media);
    const result = await this.sock.sendMessage(targetChat, {
      image: buffer,
      caption: media.caption || '',
      mimetype: media.mimetype || 'image/jpeg',
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const buffer = await this.parseMediaBuffer(media);
    const result = await this.sock.sendMessage(targetChat, {
      video: buffer,
      caption: media.caption || '',
      mimetype: media.mimetype || 'video/mp4',
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const buffer = await this.parseMediaBuffer(media);
    const result = await this.sock.sendMessage(targetChat, {
      audio: buffer,
      mimetype: media.mimetype || 'audio/mp4',
      ptt: true,
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const buffer = await this.parseMediaBuffer(media);
    const result = await this.sock.sendMessage(targetChat, {
      document: buffer,
      mimetype: media.mimetype || 'application/octet-stream',
      fileName: media.filename || 'document',
      caption: media.caption || '',
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const result = await this.sock.sendMessage(targetChat, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description || '',
        address: location.address || '',
      },
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const result = await this.sock.sendMessage(targetChat, {
      contacts: {
        displayName: contact.name,
        contacts: [{ vcard }],
      },
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const buffer = await this.parseMediaBuffer(media);
    const result = await this.sock.sendMessage(targetChat, {
      sticker: buffer,
    });
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    const result = await this.sock.sendMessage(
      targetChat,
      { text },
      {
        quoted: {
          key: {
            id: quotedMsgId,
            remoteJid: targetChat,
          },
        } as any,
      },
    );
    return {
      id: result?.key?.id || '',
      timestamp: Number(result?.messageTimestamp || Date.now()),
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    return this.sendTextMessage(toChatId, `[Forwarded from ${fromChatId}]`);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    await this.sock.sendMessage(targetChat, {
      react: {
        text: emoji,
        key: {
          id: messageId,
          remoteJid: targetChat,
        },
      },
    });
  }

  async getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return [];
  }

  async getContacts(): Promise<Contact[]> {
    return [];
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return {
      id: contactId,
      number: contactId.replace(/\D/g, ''),
      isMyContact: false,
      isBlocked: false,
    };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    try {
      const results = await this.sock.onWhatsApp(number);
      return Array.isArray(results) && results.length > 0 && Boolean(results[0]?.exists);
    } catch (_) {
      return false;
    }
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    try {
      const groupsMap = await this.sock.groupFetchAllParticipating();
      return Object.values(groupsMap).map((g: any) => ({
        id: g.id,
        name: g.subject,
        participantsCount: g.participants?.length || 0,
        isAdmin: g.participants?.some(
          (p: any) => (p.admin === 'admin' || p.admin === 'superadmin') && p.id?.includes(this.phoneNumber || ''),
        ),
      }));
    } catch (_) {
      return [];
    }
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const g = await this.sock.groupMetadata(groupId);
      return {
        id: g.id,
        name: g.subject,
        description: g.desc || undefined,
        owner: g.owner || undefined,
        createdAt: g.creation,
        participants: (g.participants || []).map((p: any) => ({
          id: p.id,
          number: p.id.split('@')[0],
          name: p.name || undefined,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
        isReadOnly: Boolean(g.announce),
        isAnnounce: Boolean(g.announce),
      };
    } catch (err) {
      this.logger.warn(`Failed to get group info: ${groupId}`, String(err));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    const formattedParticipants = participants.map(p => this.formatChatId(p));
    const result = await this.sock.groupCreate(name, formattedParticipants);
    return {
      id: result.id,
      name,
      participantsCount: formattedParticipants.length + 1,
      isAdmin: true,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const formatted = participants.map(p => this.formatChatId(p));
    await this.sock.groupParticipantsUpdate(groupId, formatted, 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const formatted = participants.map(p => this.formatChatId(p));
    await this.sock.groupParticipantsUpdate(groupId, formatted, 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const formatted = participants.map(p => this.formatChatId(p));
    await this.sock.groupParticipantsUpdate(groupId, formatted, 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const formatted = participants.map(p => this.formatChatId(p));
    await this.sock.groupParticipantsUpdate(groupId, formatted, 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupLeave(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupUpdateSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupUpdateDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return await this.sock.groupInviteCode(groupId);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return await this.sock.groupRevokeInvite(groupId);
  }

  async deleteMessage(chatId: string, messageId: string, _forEveryone = true): Promise<void> {
    this.ensureReady();
    const targetChat = this.formatChatId(chatId);
    await this.sock.sendMessage(targetChat, {
      delete: {
        id: messageId,
        remoteJid: targetChat,
        fromMe: true,
      },
    });
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const target = this.formatChatId(contactId);
      return await this.sock.profilePictureUrl(target, 'image');
    } catch (_) {
      return null;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const target = this.formatChatId(contactId);
    await this.sock.updateBlockStatus(target, 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const target = this.formatChatId(contactId);
    await this.sock.updateBlockStatus(target, 'unblock');
  }

  // Phase 3 Stubs
  async getLabels(): Promise<Label[]> { return []; }
  async getLabelById(_id: string): Promise<Label | null> { return null; }
  async getChatLabels(_chatId: string): Promise<Label[]> { return []; }
  async addLabelToChat(_chatId: string, _labelId: string): Promise<void> {}
  async removeLabelFromChat(_chatId: string, _labelId: string): Promise<void> {}
  async getSubscribedChannels(): Promise<Channel[]> { return []; }
  async getChannelById(_id: string): Promise<Channel | null> { return null; }
  async subscribeToChannel(_code: string): Promise<Channel> { throw new Error('Not supported in Baileys'); }
  async unsubscribeFromChannel(_id: string): Promise<void> {}
  async getChannelMessages(_id: string): Promise<ChannelMessage[]> { return []; }
  async getContactStatuses(): Promise<Status[]> { return []; }
  async getContactStatus(_contactId: string): Promise<Status[]> { return []; }
  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> { throw new Error('Not supported'); }
  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> { throw new Error('Not supported'); }
  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> { throw new Error('Not supported'); }
  async deleteStatus(_statusId: string): Promise<void> {}
  async getCatalog(): Promise<Catalog | null> { return null; }
  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> { return { products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }; }
  async getProduct(_id: string): Promise<Product | null> { return null; }
  async sendProduct(_chatId: string, _productId: string): Promise<MessageResult> { throw new Error('Not supported'); }
  async sendCatalog(_chatId: string): Promise<MessageResult> { throw new Error('Not supported'); }
}
