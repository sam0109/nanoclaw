/**
 * Integration test: _processInboundBatch + real GroupQueue + real SQLite
 *
 * Tests the actual piping decision code from index.ts, wired to real
 * GroupQueue and in-memory SQLite. Only the container/channel layer is mocked.
 *
 * Catches regressions that thread-integration.test.ts missed because
 * those tests replicated index.ts logic in test code rather than
 * calling the real functions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks (must be before imports) ---

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    TRIGGER_PATTERN: /^@Andy\b/i,
    MAIN_GROUP_FOLDER: '__main__',
    DATA_DIR: '/tmp/nanoclaw-test-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    STORE_DIR: '/tmp/nanoclaw-test-store',
    MAX_CONCURRENT_CONTAINERS: 5,
    POLL_INTERVAL: 2000,
    IDLE_TIMEOUT: 1800000,
    CONTAINER_IMAGE: 'test:latest',
    CONTAINER_TIMEOUT: 300000,
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    IPC_POLL_INTERVAL: 1000,
    DISCORD_BOT_TOKEN: '',
    DISCORD_ONLY: false,
    ONECLI_URL: 'http://localhost:10254',
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      existsSync: vi.fn(() => false),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock container-runner — the only external dependency in processGroupMessages
const mockRunContainerAgent = vi.fn();
vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

// Mock container-runtime — skip Docker checks
vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

import {
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { Channel, NewMessage } from './types.js';
import {
  _processInboundBatch,
  _setRegisteredGroups,
  _setChannels,
  _setThreadParents,
  _setLastAgentTimestamp,
  _getQueue,
  _wireQueue,
} from './index.js';
import type { ContainerOutput } from './container-runner.js';

// Helper to create a Discord-like channel (supports threading)
function makeDiscordChannel() {
  return {
    name: 'discord',
    connect: async () => {},
    sendMessage: vi.fn(async (_jid: string, _text: string) => {}),
    sendMessageToThread: vi.fn(
      async (_jid: string, _text: string, _triggerMessageId: string) => {},
    ),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith('dc:'),
    disconnect: async () => {},
    setTyping: vi.fn(async (_jid: string, _isTyping: boolean) => {}),
  } satisfies Channel;
}

// Helper to create a WhatsApp channel (no threading)
function makeWhatsAppChannel() {
  return {
    name: 'whatsapp',
    connect: async () => {},
    sendMessage: vi.fn(async (_jid: string, _text: string) => {}),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith('wa:'),
    disconnect: async () => {},
    setTyping: vi.fn(async (_jid: string, _isTyping: boolean) => {}),
  } satisfies Channel;
}

// Helper: store a message and return the NewMessage object
function addMessage(opts: {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
}): NewMessage {
  const msg: NewMessage = {
    id: opts.id,
    chat_jid: opts.chatJid,
    sender: opts.sender,
    sender_name: opts.senderName,
    content: opts.content,
    timestamp: opts.timestamp,
    is_from_me: false,
  };
  storeMessage(msg);
  return msg;
}

describe('Message loop integration: _processInboundBatch + real GroupQueue + real DB', () => {
  const channelJid = 'dc:1000000000000000';

  let discordChannel: ReturnType<typeof makeDiscordChannel>;

  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();

    // Reset queue state from previous test
    _getQueue()._reset();

    discordChannel = makeDiscordChannel();
    _setChannels([discordChannel]);
    _setThreadParents({});
    _setLastAgentTimestamp({});
    _setRegisteredGroups({
      [channelJid]: {
        name: 'Server #general',
        folder: 'server-general',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      },
    });

    _wireQueue();

    mockRunContainerAgent.mockReset();

    storeChatMetadata(
      channelJid,
      '2024-01-01T00:00:00.000Z',
      'Server #general',
      'discord',
      true,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('second trigger in threading channel closes active container and enqueues fresh', async () => {
    // --- First trigger ---
    addMessage({
      id: 'msg-001',
      chatJid: channelJid,
      sender: 'user1',
      senderName: 'Alice',
      content: '@Andy first question',
      timestamp: '2024-01-01T00:01:00.000Z',
    });

    // The container for the first trigger: we control it via a completion callback
    let firstOnProcess: ((proc: unknown, name: string) => void) | undefined;
    let firstOnOutput: ((output: ContainerOutput) => Promise<void>) | undefined;
    let resolveFirst: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        firstOnProcess = onProcess;
        firstOnOutput = onOutput;

        // Register a fake process so queue.sendMessage can work
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-first',
        );

        // Wait until test resolves us
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });

        return { status: 'success' as const, result: null };
      },
    );

    // Feed first trigger batch through real _processInboundBatch
    const firstBatch = new Map<string, NewMessage[]>();
    firstBatch.set(channelJid, [
      {
        id: 'msg-001',
        chat_jid: channelJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: '@Andy first question',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ]);
    _processInboundBatch(firstBatch);

    // Let the queue start processing (calls processGroupMessages → runContainerAgent)
    await vi.advanceTimersByTimeAsync(10);

    // Container should be active now
    const queue = _getQueue();
    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // Send output from first container so sendMessageToThread is called
    await firstOnOutput!({
      status: 'success',
      result: 'Answer to first question',
    });

    expect(discordChannel.sendMessageToThread).toHaveBeenCalledTimes(1);
    const firstThreadCall = discordChannel.sendMessageToThread.mock.calls[0];
    expect(firstThreadCall[2]).toBe('msg-001'); // triggerMessageId for first thread

    // --- Second trigger arrives while first container is still active ---
    addMessage({
      id: 'msg-002',
      chatJid: channelJid,
      sender: 'user2',
      senderName: 'Bob',
      content: '@Andy second question',
      timestamp: '2024-01-01T00:02:00.000Z',
    });

    // Set up the second container mock BEFORE processing the batch
    let resolveSecond: (() => void) | undefined;
    let secondOnOutput:
      | ((output: ContainerOutput) => Promise<void>)
      | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        secondOnOutput = onOutput;
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-second',
        );

        await new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });

        return { status: 'success' as const, result: null };
      },
    );

    const secondBatch = new Map<string, NewMessage[]>();
    secondBatch.set(channelJid, [
      {
        id: 'msg-002',
        chat_jid: channelJid,
        sender: 'user2',
        sender_name: 'Bob',
        content: '@Andy second question',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ]);

    // _processInboundBatch should detect isNewTriggerForThread, call closeStdin, and enqueue
    _processInboundBatch(secondBatch);
    await vi.advanceTimersByTimeAsync(10);

    // First container is still running (closeStdin just writes a sentinel file;
    // the container finishes when resolveFirst is called)
    // Complete first container
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Now the queue should drain and start the second container
    await vi.advanceTimersByTimeAsync(100);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(2);

    // Send output from second container
    await secondOnOutput!({
      status: 'success',
      result: 'Answer to second question',
    });

    // Should have two sendMessageToThread calls with different trigger IDs
    expect(discordChannel.sendMessageToThread).toHaveBeenCalledTimes(2);
    const secondThreadCall = discordChannel.sendMessageToThread.mock.calls[1];
    expect(secondThreadCall[2]).toBe('msg-002'); // triggerMessageId for second thread

    // The two trigger IDs should be different
    expect(firstThreadCall[2]).not.toBe(secondThreadCall[2]);

    // Cleanup
    resolveSecond!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('non-trigger follow-up is piped to active container when requiresTrigger=false', async () => {
    // Use a group that doesn't require triggers (e.g., solo chat)
    _setRegisteredGroups({
      [channelJid]: {
        name: 'Solo chat',
        folder: 'solo-chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    });

    // --- First message starts a container ---
    addMessage({
      id: 'msg-010',
      chatJid: channelJid,
      sender: 'user1',
      senderName: 'Alice',
      content: 'hello there',
      timestamp: '2024-01-01T00:01:00.000Z',
    });

    let resolveContainer: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        _onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-pipe',
        );
        await new Promise<void>((resolve) => {
          resolveContainer = resolve;
        });
        return { status: 'success' as const, result: null };
      },
    );

    // Feed first message through _processInboundBatch
    const triggerBatch = new Map<string, NewMessage[]>();
    triggerBatch.set(channelJid, [
      {
        id: 'msg-010',
        chat_jid: channelJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: 'hello there',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ]);
    _processInboundBatch(triggerBatch);
    await vi.advanceTimersByTimeAsync(10);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // --- Follow-up without trigger ---
    addMessage({
      id: 'msg-011',
      chatJid: channelJid,
      sender: 'user1',
      senderName: 'Alice',
      content: 'make it funnier',
      timestamp: '2024-01-01T00:01:30.000Z',
    });

    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const writesBefore = writeFileSync.mock.calls.length;

    const followUpBatch = new Map<string, NewMessage[]>();
    followUpBatch.set(channelJid, [
      {
        id: 'msg-011',
        chat_jid: channelJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: 'make it funnier',
        timestamp: '2024-01-01T00:01:30.000Z',
      },
    ]);
    _processInboundBatch(followUpBatch);

    // The follow-up should have been piped (IPC file written), not enqueued
    const writesAfter = writeFileSync.mock.calls.length;
    expect(writesAfter).toBeGreaterThan(writesBefore);

    // Verify no second container was started
    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // Cleanup
    resolveContainer!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('thread follow-up with trigger is piped (no new thread needed)', async () => {
    const threadJid = 'dc:1000111111111111';

    // Set up thread mapping
    _setThreadParents({ [threadJid]: channelJid });

    storeChatMetadata(
      threadJid,
      '2024-01-01T00:00:01.000Z',
      'Thread',
      'discord',
      true,
    );

    // --- Start container via trigger on the parent channel ---
    addMessage({
      id: 'msg-020',
      chatJid: channelJid,
      sender: 'user1',
      senderName: 'Alice',
      content: '@Andy hi',
      timestamp: '2024-01-01T00:01:00.000Z',
    });

    let resolveContainer: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        _onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-thread',
        );
        await new Promise<void>((resolve) => {
          resolveContainer = resolve;
        });
        return { status: 'success' as const, result: null };
      },
    );

    const triggerBatch = new Map<string, NewMessage[]>();
    triggerBatch.set(channelJid, [
      {
        id: 'msg-020',
        chat_jid: channelJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: '@Andy hi',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ]);
    _processInboundBatch(triggerBatch);
    await vi.advanceTimersByTimeAsync(10);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // --- Trigger in thread should be piped, not detected as isNewTriggerForThread ---
    addMessage({
      id: 'msg-021',
      chatJid: threadJid,
      sender: 'user1',
      senderName: 'Alice',
      content: '@Andy follow up',
      timestamp: '2024-01-01T00:02:00.000Z',
    });

    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const writesBefore = writeFileSync.mock.calls.length;

    const threadBatch = new Map<string, NewMessage[]>();
    threadBatch.set(threadJid, [
      {
        id: 'msg-021',
        chat_jid: threadJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: '@Andy follow up',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ]);
    _processInboundBatch(threadBatch);

    // Should be piped (IPC file written), NOT enqueued as a new trigger
    const writesAfter = writeFileSync.mock.calls.length;
    expect(writesAfter).toBeGreaterThan(writesBefore);

    // No second container started
    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // Cleanup
    resolveContainer!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('WhatsApp trigger is piped (no threading support)', async () => {
    const waJid = 'wa:1234567890@g.us';

    const waChannel = makeWhatsAppChannel();
    _setChannels([discordChannel, waChannel]);
    _setRegisteredGroups({
      [channelJid]: {
        name: 'Server #general',
        folder: 'server-general',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      },
      [waJid]: {
        name: 'WA Group',
        folder: 'wa-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      },
    });

    storeChatMetadata(
      waJid,
      '2024-01-01T00:00:00.000Z',
      'WA Group',
      'whatsapp',
      true,
    );

    // --- First trigger starts container ---
    addMessage({
      id: 'msg-030',
      chatJid: waJid,
      sender: 'user1',
      senderName: 'Alice',
      content: '@Andy hello',
      timestamp: '2024-01-01T00:01:00.000Z',
    });

    let resolveContainer: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        _onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-wa',
        );
        await new Promise<void>((resolve) => {
          resolveContainer = resolve;
        });
        return { status: 'success' as const, result: null };
      },
    );

    const firstBatch = new Map<string, NewMessage[]>();
    firstBatch.set(waJid, [
      {
        id: 'msg-030',
        chat_jid: waJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: '@Andy hello',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ]);
    _processInboundBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(10);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // --- Second trigger on WhatsApp (no threading) should be piped ---
    addMessage({
      id: 'msg-031',
      chatJid: waJid,
      sender: 'user2',
      senderName: 'Bob',
      content: '@Andy another question',
      timestamp: '2024-01-01T00:02:00.000Z',
    });

    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const writesBefore = writeFileSync.mock.calls.length;

    const secondBatch = new Map<string, NewMessage[]>();
    secondBatch.set(waJid, [
      {
        id: 'msg-031',
        chat_jid: waJid,
        sender: 'user2',
        sender_name: 'Bob',
        content: '@Andy another question',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ]);
    _processInboundBatch(secondBatch);

    // For WhatsApp (no sendMessageToThread), triggers should be piped to active container
    const writesAfter = writeFileSync.mock.calls.length;
    expect(writesAfter).toBeGreaterThan(writesBefore);

    // No second container started — piped to the first
    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // Cleanup
    resolveContainer!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('two triggers produce two separate threads end-to-end', async () => {
    // --- First trigger ---
    addMessage({
      id: 'msg-040',
      chatJid: channelJid,
      sender: 'user1',
      senderName: 'Alice',
      content: '@Andy question one',
      timestamp: '2024-01-01T00:01:00.000Z',
    });

    let firstOnOutput: ((output: ContainerOutput) => Promise<void>) | undefined;
    let resolveFirst: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        firstOnOutput = onOutput;
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-e2e-1',
        );
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { status: 'success' as const, result: null };
      },
    );

    // Process first trigger
    const firstBatch = new Map<string, NewMessage[]>();
    firstBatch.set(channelJid, [
      {
        id: 'msg-040',
        chat_jid: channelJid,
        sender: 'user1',
        sender_name: 'Alice',
        content: '@Andy question one',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
    ]);
    _processInboundBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(10);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(1);

    // First container sends output
    await firstOnOutput!({ status: 'success', result: 'Answer one' });
    expect(discordChannel.sendMessageToThread).toHaveBeenCalledTimes(1);
    expect(discordChannel.sendMessageToThread.mock.calls[0][2]).toBe('msg-040');

    // --- Second trigger arrives while first is still alive ---
    addMessage({
      id: 'msg-041',
      chatJid: channelJid,
      sender: 'user2',
      senderName: 'Bob',
      content: '@Andy question two',
      timestamp: '2024-01-01T00:02:00.000Z',
    });

    let secondOnOutput:
      | ((output: ContainerOutput) => Promise<void>)
      | undefined;
    let resolveSecond: (() => void) | undefined;

    mockRunContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        _opts: unknown,
        onProcess: (proc: unknown, name: string) => void,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        secondOnOutput = onOutput;
        onProcess(
          { stdin: { write: vi.fn() }, killed: false } as any,
          'container-e2e-2',
        );
        await new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });
        return { status: 'success' as const, result: null };
      },
    );

    const secondBatch = new Map<string, NewMessage[]>();
    secondBatch.set(channelJid, [
      {
        id: 'msg-041',
        chat_jid: channelJid,
        sender: 'user2',
        sender_name: 'Bob',
        content: '@Andy question two',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ]);
    _processInboundBatch(secondBatch);
    await vi.advanceTimersByTimeAsync(10);

    // Complete first container → queue drains → second starts
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockRunContainerAgent).toHaveBeenCalledTimes(2);

    // Second container sends output
    await secondOnOutput!({ status: 'success', result: 'Answer two' });

    // Verify two separate threads were created
    expect(discordChannel.sendMessageToThread).toHaveBeenCalledTimes(2);
    const call1TriggerID = discordChannel.sendMessageToThread.mock.calls[0][2];
    const call2TriggerID = discordChannel.sendMessageToThread.mock.calls[1][2];

    expect(call1TriggerID).toBe('msg-040');
    expect(call2TriggerID).toBe('msg-041');
    expect(call1TriggerID).not.toBe(call2TriggerID);

    // Cleanup
    resolveSecond!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
