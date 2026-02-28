// Polyfill IndexedDB for Node.js — must be imported before matrix-js-sdk
// so the Rust crypto WASM can use it for E2EE key storage.
// Keys persist for the process lifetime; lost on restart (WASM limitation).
import 'fake-indexeddb/auto';

import fs from 'fs';
import path from 'path';

import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  EventType,
  MsgType,
  SyncState,
  KnownMembership,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';

import { MATRIX_HOMESERVER, MATRIX_USER_ID, STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CREDENTIALS_PATH = path.join(
  STORE_DIR,
  'matrix-auth',
  'credentials.json',
);
const CRYPTO_STORE_PATH = path.join(STORE_DIR, 'matrix-crypto');

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface MatrixCredentials {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client!: MatrixClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Load credentials from file (saved by matrix-auth.ts)
    let creds: MatrixCredentials;
    try {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
      creds = JSON.parse(raw);
    } catch {
      throw new Error(
        `Matrix credentials not found at ${CREDENTIALS_PATH}. Run 'npm run matrix-auth' first.`,
      );
    }

    // Read access token: prefer .env over credentials file for easier rotation
    const secrets = readEnvFile(['MATRIX_ACCESS_TOKEN']);
    const accessToken = secrets.MATRIX_ACCESS_TOKEN || creds.accessToken;
    const homeserver = MATRIX_HOMESERVER || creds.homeserver;
    const userId = MATRIX_USER_ID || creds.userId;
    const deviceId = creds.deviceId;

    if (!accessToken) {
      throw new Error(
        'MATRIX_ACCESS_TOKEN not found in .env or credentials file',
      );
    }

    // Ensure crypto store directory exists
    fs.mkdirSync(CRYPTO_STORE_PATH, { recursive: true });

    this.client = createClient({
      baseUrl: homeserver,
      accessToken,
      userId,
      deviceId,
    });

    // Initialize E2EE — fake-indexeddb provides the IndexedDB backend
    await this.client.initRustCrypto();
    logger.info('Matrix E2EE initialized');

    // Register event handlers before starting sync
    this.registerEventHandlers();

    // Wait for initial sync to complete
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Matrix sync timed out after 60s'));
      }, 60_000);

      const onSync = (state: SyncState) => {
        if (state === SyncState.Prepared) {
          clearTimeout(timeout);
          this.client.removeListener(ClientEvent.Sync, onSync);
          resolve();
        } else if (state === SyncState.Error) {
          clearTimeout(timeout);
          this.client.removeListener(ClientEvent.Sync, onSync);
          reject(new Error('Matrix sync failed'));
        }
      };
      this.client.on(ClientEvent.Sync, onSync);

      this.client.startClient({ initialSyncLimit: 10 }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.connected = true;
    logger.info('Connected to Matrix');

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush outgoing queue'),
    );

    // Sync room metadata on startup (respects 24h cache)
    this.syncRoomMetadata().catch((err) =>
      logger.error({ err }, 'Initial room sync failed'),
    );
    // Set up daily sync timer (only once)
    if (!this.groupSyncTimerStarted) {
      this.groupSyncTimerStarted = true;
      setInterval(() => {
        this.syncRoomMetadata().catch((err) =>
          logger.error({ err }, 'Periodic room sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    }
  }

  private registerEventHandlers(): void {
    // Handle incoming messages
    this.client.on(
      RoomEvent.Timeline,
      (event: MatrixEvent, room: Room | undefined) => {
        try {
          this.handleTimelineEvent(event, room);
        } catch (err) {
          logger.error(
            { err, eventId: event.getId() },
            'Error handling timeline event',
          );
        }
      },
    );

    // Track connection state
    this.client.on(
      ClientEvent.Sync,
      (state: SyncState, prevState: SyncState | null) => {
        if (state === SyncState.Error) {
          logger.warn('Matrix sync error — will retry');
          this.connected = false;
        } else if (
          state === SyncState.Syncing &&
          prevState === SyncState.Error
        ) {
          logger.info('Matrix sync recovered');
          this.connected = true;
          this.flushOutgoingQueue().catch((err) =>
            logger.error(
              { err },
              'Failed to flush outgoing queue on reconnect',
            ),
          );
        } else if (
          state === SyncState.Syncing ||
          state === SyncState.Prepared
        ) {
          this.connected = true;
        }
      },
    );

    // Auto-join rooms on invite
    this.client.on(
      RoomMemberEvent.Membership,
      (_event: MatrixEvent, member: RoomMember) => {
        if (
          member.membership === KnownMembership.Invite &&
          member.userId === this.client.getUserId()
        ) {
          logger.info(
            { roomId: member.roomId },
            'Invited to room, auto-joining',
          );
          this.client
            .joinRoom(member.roomId)
            .catch((err) =>
              logger.error(
                { err, roomId: member.roomId },
                'Failed to auto-join room',
              ),
            );
        }
      },
    );
  }

  private handleTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
  ): void {
    // Only process message events
    if (event.getType() !== EventType.RoomMessage) return;

    const roomId = event.getRoomId();
    if (!roomId) return;

    const timestamp = new Date(event.getTs()).toISOString();
    const roomName = room?.name || roomId;
    // Matrix rooms with '!' are always groups/rooms (not DMs in the traditional sense)
    // but we treat DMs (rooms with exactly 2 members) as non-group
    const memberCount = room?.getJoinedMemberCount() || 0;
    const isGroup = memberCount > 2;

    // Always notify about chat metadata for room discovery
    this.opts.onChatMetadata(roomId, timestamp, roomName, 'matrix', isGroup);

    // Only deliver full message for registered rooms
    const groups = this.opts.registeredGroups();
    if (!groups[roomId]) return;

    const sender = event.getSender();
    if (!sender) return;

    // Skip bot's own messages
    const isFromMe = sender === this.client.getUserId();
    if (isFromMe) return;

    const content = event.getContent();
    const msgtype = content.msgtype as string;

    let text = '';
    if (
      msgtype === MsgType.Text ||
      msgtype === MsgType.Notice ||
      msgtype === MsgType.Emote
    ) {
      text = content.body || '';
    } else if (msgtype === MsgType.Image) {
      text = content.body ? `[Image: ${content.body}]` : '[Image]';
    } else if (msgtype === MsgType.File) {
      text = content.body ? `[File: ${content.body}]` : '[File]';
    } else if (msgtype === MsgType.Audio) {
      text = content.body ? `[Audio: ${content.body}]` : '[Audio]';
    } else if (msgtype === MsgType.Video) {
      text = content.body ? `[Video: ${content.body}]` : '[Video]';
    }

    if (!text) return;

    // Strip Matrix reply fallback prefix (lines starting with > until blank line)
    text = text.replace(/^(>.*\n)*\n?/, '');
    if (!text.trim()) return;

    // Extract display name from sender (e.g., "@alice:matrix.org" → "alice")
    const senderName =
      room?.getMember(sender)?.name || sender.split(':')[0].slice(1);

    const eventId =
      event.getId() ||
      `mx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.opts.onMessage(roomId, {
      id: eventId,
      chat_jid: roomId,
      sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // No name prefix — Matrix bot has its own identity
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Matrix disconnected, message queued',
      );
      return;
    }
    try {
      await this.client.sendEvent(jid, EventType.RoomMessage, {
        msgtype: MsgType.Text,
        body: text,
      });
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('!');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.stopClient();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.sendTyping(jid, isTyping, 30_000);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync room metadata from Matrix.
   * Iterates all joined rooms and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncRoomMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping room sync — synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing room metadata from Matrix...');
      const rooms = this.client.getRooms();

      let count = 0;
      for (const room of rooms) {
        if (room.name) {
          updateChatName(room.roomId, room.name);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Room metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync room metadata');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.client.sendEvent(item.jid, EventType.RoomMessage, {
          msgtype: MsgType.Text,
          body: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
