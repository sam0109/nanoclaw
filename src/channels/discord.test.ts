import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      // Fire the ready event
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        h({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel type
  class TextChannel {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    TextChannel,
  };
});

import { DiscordChannel, DiscordChannelOpts } from './discord.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
  isThread?: boolean;
  parentId?: string;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      isThread: () => overrides.isThread ?? false,
      parentId: overrides.parentId ?? null,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: a.png]\n[File: b.txt]',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel =
        await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- sendMessageToThread ---

  describe('sendMessageToThread', () => {
    it('creates a thread from trigger message and sends there', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Hello from thread!',
        'trigger_msg_001',
      );

      expect(mockChannel.threads.create).toHaveBeenCalledWith({
        startMessage: 'trigger_msg_001',
        name: 'Hello from thread!',
      });
      expect(threadSend).toHaveBeenCalledWith('Hello from thread!');
      // Original channel's send should NOT be called
      expect(mockChannel.send).not.toHaveBeenCalled();
    });

    it('reuses cached thread on subsequent calls with same trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const cachedThreadChannel = {
        send: threadSend,
        isThread: () => false,
      };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };

      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      // First call — creates thread
      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'First message',
        'trigger_msg_001',
      );
      expect(mockChannel.threads.create).toHaveBeenCalledTimes(1);

      // Second call — should reuse cached thread
      currentClient().channels.fetch.mockImplementation(async (id: string) => {
        if (id === 'thread_001') return cachedThreadChannel;
        return mockChannel;
      });

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Second message',
        'trigger_msg_001',
      );

      // threads.create should NOT be called a second time
      expect(mockChannel.threads.create).toHaveBeenCalledTimes(1);
      // But the thread's send should have been called for the second message
      expect(threadSend).toHaveBeenCalledWith('Second message');
    });

    it('falls back to plain send on thread creation error', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const plainSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: plainSend,
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Fallback message',
        'trigger_msg_001',
      );

      // Should have fallen back to sendMessage (which calls channel.send)
      expect(plainSend).toHaveBeenCalledWith('Fallback message');
    });

    it('splits long messages in thread (2000 char limit)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessageToThread(
        'dc:1234567890123456',
        longText,
        'trigger_msg_001',
      );

      expect(threadSend).toHaveBeenCalledTimes(2);
      expect(threadSend).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(threadSend).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });

    it('delegates to sendMessage when JID is already a thread', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: threadSend,
        sendTyping: vi.fn(),
        isThread: () => true,
        threads: {
          create: vi.fn(),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1111222233334444',
        'Already in a thread',
        'trigger_msg_001',
      );

      // Should send directly without creating a thread
      expect(mockChannel.threads.create).not.toHaveBeenCalled();
      expect(threadSend).toHaveBeenCalledWith('Already in a thread');
    });

    it('derives thread name from first ~90 chars of response text', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longResponse = 'A'.repeat(100) + ' rest of text';
      await channel.sendMessageToThread(
        'dc:1234567890123456',
        longResponse,
        'trigger_msg_001',
      );

      // Thread name should be truncated to 90 chars
      expect(mockChannel.threads.create).toHaveBeenCalledWith({
        startMessage: 'trigger_msg_001',
        name: 'A'.repeat(90),
      });
    });

    it('replaces newlines in thread name', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Line one\nLine two\nLine three',
        'trigger_msg_001',
      );

      expect(mockChannel.threads.create).toHaveBeenCalledWith({
        startMessage: 'trigger_msg_001',
        name: 'Line one Line two Line three',
      });
    });

    it('uses "Response" as thread name when text is empty after trim', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        '   ',
        'trigger_msg_001',
      );

      expect(mockChannel.threads.create).toHaveBeenCalledWith({
        startMessage: 'trigger_msg_001',
        name: 'Response',
      });
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'No client',
        'trigger_msg_001',
      );

      // No error
    });

    it('calls onThreadMapping when creating a new thread', async () => {
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({ onThreadMapping });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Hello from thread!',
        'trigger_msg_001',
      );

      expect(onThreadMapping).toHaveBeenCalledWith(
        'dc:thread_001',
        'dc:1234567890123456',
      );
    });

    it('does NOT call onThreadMapping when reusing cached thread', async () => {
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({ onThreadMapping });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockThread = { id: 'thread_001', send: threadSend };
      const cachedThreadChannel = {
        send: threadSend,
        isThread: () => false,
      };
      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
        isThread: () => false,
        threads: {
          create: vi.fn().mockResolvedValue(mockThread),
        },
      };

      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      // First call — creates thread (calls onThreadMapping)
      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'First message',
        'trigger_msg_001',
      );
      expect(onThreadMapping).toHaveBeenCalledTimes(1);

      // Second call — should reuse cached thread (no new onThreadMapping call)
      currentClient().channels.fetch.mockImplementation(async (id: string) => {
        if (id === 'thread_001') return cachedThreadChannel;
        return mockChannel;
      });

      await channel.sendMessageToThread(
        'dc:1234567890123456',
        'Second message',
        'trigger_msg_001',
      );

      // onThreadMapping should NOT be called again
      expect(onThreadMapping).toHaveBeenCalledTimes(1);
    });

    it('does NOT call onThreadMapping when channel is already a thread', async () => {
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({ onThreadMapping });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: threadSend,
        sendTyping: vi.fn(),
        isThread: () => true,
        threads: {
          create: vi.fn(),
        },
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessageToThread(
        'dc:1111222233334444',
        'Already in a thread',
        'trigger_msg_001',
      );

      // Should not call onThreadMapping (no new thread created)
      expect(onThreadMapping).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });

  // --- Thread handling ---

  describe('thread handling', () => {
    it('calls onThreadMapping for thread messages', async () => {
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({
        onThreadMapping,
        registeredGroups: vi.fn(() => ({
          'dc:9999000000000000': {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '1111222233334444',
        content: 'Hello from thread',
        guildName: 'Server',
        channelName: 'thread-name',
        isThread: true,
        parentId: '9999000000000000',
      });
      await triggerMessage(msg);

      expect(onThreadMapping).toHaveBeenCalledWith(
        'dc:1111222233334444',
        'dc:9999000000000000',
      );
    });

    it('uses parent JID for group lookup', async () => {
      const parentChannelId = '9999000000000000';
      const threadChannelId = '1111222233334444';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: threadChannelId,
        content: 'Thread message',
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      // Message should be delivered (not dropped as unregistered)
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.objectContaining({
          chat_jid: `dc:${threadChannelId}`,
          content: 'Thread message',
        }),
      );
    });

    it('auto-registers with parent JID, not thread JID', async () => {
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({})), // nothing registered
        onRegisterGroup,
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '1111222233334444',
        content: 'First thread message',
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: '9999000000000000',
      });
      await triggerMessage(msg);

      // Should register with parent JID
      expect(onRegisterGroup).toHaveBeenCalledWith(
        'dc:9999000000000000',
        expect.objectContaining({
          name: expect.any(String),
          folder: expect.any(String),
        }),
      );
      // Should NOT register with thread JID
      expect(onRegisterGroup).not.toHaveBeenCalledWith(
        'dc:1111222233334444',
        expect.anything(),
      );
    });

    it('stores message with thread JID as chat_jid', async () => {
      const threadChannelId = '1111222233334444';
      const parentChannelId = '9999000000000000';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: threadChannelId,
        content: 'In thread',
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      // onMessage should receive thread JID, not parent JID
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.objectContaining({
          chat_jid: `dc:${threadChannelId}`,
        }),
      );
    });

    it('stores chat metadata with thread JID', async () => {
      const threadChannelId = '1111222233334444';
      const parentChannelId = '9999000000000000';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: threadChannelId,
        content: 'In thread',
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      // onChatMetadata receives the thread JID
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.any(String),
        'Server #my-thread',
      );
    });

    it('does not call onThreadMapping for non-thread messages', async () => {
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({ onThreadMapping });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Regular message',
        guildName: 'Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(onThreadMapping).not.toHaveBeenCalled();
    });

    it('thread message is dropped when parent is unregistered and no onRegisterGroup', async () => {
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({})), // nothing registered
        // no onRegisterGroup — so auto-registration is disabled
      });
      // Remove onRegisterGroup from opts
      delete (opts as any).onRegisterGroup;
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '1111222233334444',
        content: 'Thread msg',
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: '9999000000000000',
      });
      await triggerMessage(msg);

      // Should not deliver the message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('thread @bot mention translates and uses parent for group lookup', async () => {
      const parentChannelId = '9999000000000000';
      const threadChannelId = '1111222233334444';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: threadChannelId,
        content: '<@999888777> help me',
        mentionsBotId: true,
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      // Message should be delivered with trigger translated
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.objectContaining({
          chat_jid: `dc:${threadChannelId}`,
          content: '@Andy help me',
        }),
      );
    });

    it('thread with attachment uses parent for group lookup', async () => {
      const parentChannelId = '9999000000000000';
      const threadChannelId = '1111222233334444';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'doc.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        channelId: threadChannelId,
        content: 'Check this file',
        attachments,
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.objectContaining({
          chat_jid: `dc:${threadChannelId}`,
          content: 'Check this file\n[File: doc.pdf]',
        }),
      );
    });

    it('multiple threads from same parent each get unique chat_jid', async () => {
      const parentChannelId = '9999000000000000';
      const onThreadMapping = vi.fn();
      const opts = createTestOpts({
        onThreadMapping,
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      // Message from thread 1
      await triggerMessage(
        createMessage({
          channelId: '1111111111111111',
          content: 'Thread 1 msg',
          guildName: 'Server',
          channelName: 'thread-1',
          isThread: true,
          parentId: parentChannelId,
        }),
      );

      // Message from thread 2
      await triggerMessage(
        createMessage({
          channelId: '2222222222222222',
          content: 'Thread 2 msg',
          guildName: 'Server',
          channelName: 'thread-2',
          isThread: true,
          parentId: parentChannelId,
        }),
      );

      // Both should map to the same parent
      expect(onThreadMapping).toHaveBeenCalledTimes(2);
      expect(onThreadMapping).toHaveBeenCalledWith(
        'dc:1111111111111111',
        `dc:${parentChannelId}`,
      );
      expect(onThreadMapping).toHaveBeenCalledWith(
        'dc:2222222222222222',
        `dc:${parentChannelId}`,
      );

      // Each message should have its own chat_jid
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1111111111111111',
        expect.objectContaining({ chat_jid: 'dc:1111111111111111' }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:2222222222222222',
        expect.objectContaining({ chat_jid: 'dc:2222222222222222' }),
      );
    });

    it('thread with reply context works correctly', async () => {
      const parentChannelId = '9999000000000000';
      const threadChannelId = '1111222233334444';
      const opts = createTestOpts({
        onThreadMapping: vi.fn(),
        registeredGroups: vi.fn(() => ({
          [`dc:${parentChannelId}`]: {
            name: 'Server #general',
            folder: 'server-general',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: threadChannelId,
        content: 'I agree',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
        channelName: 'my-thread',
        isThread: true,
        parentId: parentChannelId,
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${threadChannelId}`,
        expect.objectContaining({
          chat_jid: `dc:${threadChannelId}`,
          content: '[Reply to Bob] I agree',
        }),
      );
    });

    it('sendMessage routes to thread channel, not parent', async () => {
      const opts = createTestOpts({ onThreadMapping: vi.fn() });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadJid = 'dc:1111222233334444';
      await channel.sendMessage(threadJid, 'Reply to thread');

      // Should fetch the thread channel ID, not the parent
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1111222233334444',
      );
    });
  });
});
