/**
 * Integration test: Discord threads share parent channel's group
 *
 * Replays the full scenario to prevent regressions:
 * 1. Two threads from the same parent channel store messages independently
 * 2. GroupQueue serializes processing for threads sharing a parent
 * 3. processMessagesFn receives the original thread JID (not resolved parent)
 * 4. Messages are queried per-thread (history isolation)
 * 5. Both threads share the same group folder/session (via parent registration)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  _initTestDatabase,
  deleteRegisteredGroup,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { Channel, RegisteredGroup } from './types.js';

// Mock config
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs operations used by GroupQueue IPC
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('Thread integration: threads share parent group', () => {
  // Simulated state
  const parentJid = 'dc:9999000000000000';
  const thread1Jid = 'dc:1111111111111111';
  const thread2Jid = 'dc:2222222222222222';

  // Thread-to-parent mapping (simulates what index.ts maintains)
  const threadParents: Record<string, string> = {
    [thread1Jid]: parentJid,
    [thread2Jid]: parentJid,
  };

  function resolveParentJid(jid: string): string {
    return threadParents[jid] || jid;
  }

  // Registered groups (parent channel is registered, threads are NOT)
  const registeredGroups: Record<string, { name: string; folder: string }> = {
    [parentJid]: {
      name: 'Server #general',
      folder: 'server-general',
    },
  };

  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();
    queue = new GroupQueue();
    queue.setResolveGroupJidFn(resolveParentJid);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- DB layer: thread messages are isolated ---

  it('stores messages per-thread and queries them independently', () => {
    // Store chat metadata for both threads
    storeChatMetadata(
      thread1Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 1',
      'discord',
      true,
    );
    storeChatMetadata(
      thread2Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 2',
      'discord',
      true,
    );

    // Store messages from thread 1
    storeMessage({
      id: 't1-msg1',
      chat_jid: thread1Jid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy hello from thread 1',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 't1-msg2',
      chat_jid: thread1Jid,
      sender: 'user1',
      sender_name: 'Alice',
      content: 'more context in thread 1',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    // Store messages from thread 2
    storeMessage({
      id: 't2-msg1',
      chat_jid: thread2Jid,
      sender: 'user2',
      sender_name: 'Bob',
      content: '@Andy hello from thread 2',
      timestamp: '2024-01-01T00:00:04.000Z',
      is_from_me: false,
    });

    // Query thread 1 — should only get thread 1 messages
    const t1Messages = getMessagesSince(thread1Jid, '', 'Andy');
    expect(t1Messages).toHaveLength(2);
    expect(t1Messages[0].content).toBe('@Andy hello from thread 1');
    expect(t1Messages[1].content).toBe('more context in thread 1');

    // Query thread 2 — should only get thread 2 messages
    const t2Messages = getMessagesSince(thread2Jid, '', 'Andy');
    expect(t2Messages).toHaveLength(1);
    expect(t2Messages[0].content).toBe('@Andy hello from thread 2');

    // Query parent — should get NO messages (messages stored by thread JID)
    const parentMessages = getMessagesSince(parentJid, '', 'Andy');
    expect(parentMessages).toHaveLength(0);
  });

  it('getNewMessages includes thread JIDs in polling', () => {
    storeChatMetadata(
      thread1Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 1',
      'discord',
      true,
    );
    storeChatMetadata(
      thread2Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 2',
      'discord',
      true,
    );

    storeMessage({
      id: 't1-msg1',
      chat_jid: thread1Jid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy thread 1',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 't2-msg1',
      chat_jid: thread2Jid,
      sender: 'user2',
      sender_name: 'Bob',
      content: '@Andy thread 2',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    // Simulate what startMessageLoop does: include both registered + thread JIDs
    const jids = [
      ...Object.keys(registeredGroups),
      ...Object.keys(threadParents),
    ];

    const { messages } = getNewMessages(jids, '', 'Andy');

    // Should find messages from both threads
    const threadJids = messages.map((m) => m.chat_jid);
    expect(threadJids).toContain(thread1Jid);
    expect(threadJids).toContain(thread2Jid);
  });

  // --- GroupQueue + processMessages: correct JID routing ---

  it('processMessagesFn receives original thread JIDs, not resolved parent', async () => {
    const calledWith: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      calledWith.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue messages from two threads
    queue.enqueueMessageCheck(thread1Jid);
    queue.enqueueMessageCheck(thread2Jid);

    await vi.advanceTimersByTimeAsync(10);

    // Only thread-1 should be processing (serialized by parent)
    expect(calledWith).toEqual([thread1Jid]);

    // Complete thread-1 — thread-2 should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(calledWith).toEqual([thread1Jid, thread2Jid]);

    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Full scenario replay ---

  it('end-to-end: two threads share group but have isolated history', async () => {
    // Step 1: Store messages from both threads (simulates Discord channel delivering)
    storeChatMetadata(
      thread1Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 1',
      'discord',
      true,
    );
    storeChatMetadata(
      thread2Jid,
      '2024-01-01T00:00:01.000Z',
      'Thread 2',
      'discord',
      true,
    );

    storeMessage({
      id: 't1-msg1',
      chat_jid: thread1Jid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy remember my name is Alice',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 't2-msg1',
      chat_jid: thread2Jid,
      sender: 'user2',
      sender_name: 'Bob',
      content: '@Andy what is my name?',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    // Step 2: Simulate processGroupMessages — the function that GroupQueue calls
    const lastAgentTimestamp: Record<string, string> = {};
    const processedGroups: Array<{
      chatJid: string;
      parentJid: string;
      group: { name: string; folder: string };
      messages: Array<{ content: string; chat_jid: string }>;
    }> = [];

    const processGroupMessages = async (chatJid: string): Promise<boolean> => {
      // Resolve to parent for group lookup (what index.ts does)
      const parent = resolveParentJid(chatJid);
      const group = registeredGroups[parent];
      if (!group) return true; // no group → skip

      // Query messages by the THREAD JID (what index.ts does)
      const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
      const messages = getMessagesSince(chatJid, sinceTimestamp, 'Andy');

      if (messages.length > 0) {
        processedGroups.push({
          chatJid,
          parentJid: parent,
          group,
          messages: messages.map((m) => ({
            content: m.content,
            chat_jid: m.chat_jid,
          })),
        });

        // Advance cursor for this specific thread
        lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
      }

      return true;
    };

    queue.setProcessMessagesFn(processGroupMessages);

    // Step 3: Enqueue both threads
    queue.enqueueMessageCheck(thread1Jid);
    queue.enqueueMessageCheck(thread2Jid);

    // Let both process (serialized)
    await vi.advanceTimersByTimeAsync(100);

    // Step 4: Verify results
    expect(processedGroups).toHaveLength(2);

    // Thread 1: received thread-1 JID, found thread-1 messages, used parent's group
    const t1 = processedGroups.find((p) => p.chatJid === thread1Jid)!;
    expect(t1).toBeDefined();
    expect(t1.parentJid).toBe(parentJid);
    expect(t1.group.folder).toBe('server-general'); // parent's folder
    expect(t1.messages).toHaveLength(1);
    expect(t1.messages[0].content).toBe('@Andy remember my name is Alice');
    expect(t1.messages[0].chat_jid).toBe(thread1Jid); // history isolated

    // Thread 2: received thread-2 JID, found thread-2 messages, used same parent's group
    const t2 = processedGroups.find((p) => p.chatJid === thread2Jid)!;
    expect(t2).toBeDefined();
    expect(t2.parentJid).toBe(parentJid);
    expect(t2.group.folder).toBe('server-general'); // same parent folder
    expect(t2.messages).toHaveLength(1);
    expect(t2.messages[0].content).toBe('@Andy what is my name?');
    expect(t2.messages[0].chat_jid).toBe(thread2Jid); // history isolated

    // Step 5: Verify cursor isolation — re-enqueue thread 1 should find nothing new
    queue.enqueueMessageCheck(thread1Jid);
    await vi.advanceTimersByTimeAsync(100);

    // processedGroups should still be 2 (no new messages for thread 1)
    expect(processedGroups).toHaveLength(2);
  });

  // --- Concurrency: threads from same parent can't run simultaneously ---

  it('two threads from same parent never run concurrently', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck(thread1Jid);
    queue.enqueueMessageCheck(thread2Jid);

    await vi.advanceTimersByTimeAsync(10);
    expect(maxConcurrent).toBe(1);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(maxConcurrent).toBe(1); // still max 1

    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(2);
  });

  // --- Thread + independent group can run in parallel ---

  it('thread and independent group CAN run concurrently', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Thread from discord parent + independent WhatsApp group
    queue.enqueueMessageCheck(thread1Jid);
    queue.enqueueMessageCheck('wa-group@g.us');

    await vi.advanceTimersByTimeAsync(10);

    // Both should run in parallel (different resolved parents)
    expect(maxConcurrent).toBe(2);

    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- sendMessage via thread JID pipes to parent's container ---

  it('sendMessage via thread JID finds parent active container', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing via thread-1
    queue.enqueueMessageCheck(thread1Jid);
    await vi.advanceTimersByTimeAsync(10);

    // Register process with parent's folder (simulates container-runner callback)
    queue.registerProcess(
      parentJid,
      {} as any,
      'container-1',
      'server-general',
    );

    // sendMessage via thread-2 should find the parent's active container
    const result = queue.sendMessage(thread2Jid, 'hello from thread 2');
    expect(result).toBe(true);

    // Verify IPC file targets the parent's groupFolder
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const ipcWrites = writeFileSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('server-general'),
    );
    expect(ipcWrites.length).toBeGreaterThan(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Three threads: regression for pendingMessageJids drain bug ---

  it('three threads from same parent all get processed (drain regression)', async () => {
    const thread3Jid = 'dc:3333333333333333';
    threadParents[thread3Jid] = parentJid;

    const calledWith: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      calledWith.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start thread-1
    queue.enqueueMessageCheck(thread1Jid);
    await vi.advanceTimersByTimeAsync(10);
    expect(calledWith).toEqual([thread1Jid]);

    // While thread-1 is active, enqueue thread-2 and thread-3
    queue.enqueueMessageCheck(thread2Jid);
    queue.enqueueMessageCheck(thread3Jid);

    // Complete thread-1
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    // Thread-2 should process next
    expect(calledWith).toHaveLength(2);
    expect(calledWith[1]).toBe(thread2Jid);

    // Complete thread-2
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    // Thread-3 should process last
    expect(calledWith).toHaveLength(3);
    expect(calledWith[2]).toBe(thread3Jid);

    // Cleanup
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);

    delete threadParents[thread3Jid];
  });
});

/**
 * Integration test: Thread messages skip trigger requirement
 *
 * When the bot creates a thread from a trigger message, subsequent messages
 * in that thread should NOT require @Andy to get a response. The thread is
 * already a conversation with the bot.
 */
describe('Thread trigger bypass: threads skip requiresTrigger', () => {
  const TRIGGER_PATTERN = /^@Andy\b/i;
  const MAIN_GROUP_FOLDER = '__main__';
  const parentJid = 'dc:8888000000000000';
  const threadJid = 'dc:8888111111111111';

  // Thread-to-parent mapping
  const threadParents: Record<string, string> = {
    [threadJid]: parentJid,
  };

  // Parent group requires trigger
  const registeredGroups: Record<string, RegisteredGroup> = {
    [parentJid]: {
      name: 'Server #general',
      folder: 'server-general',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    },
  };

  function resolveParentJid(jid: string): string {
    return threadParents[jid] || jid;
  }

  beforeEach(() => {
    _initTestDatabase();

    storeChatMetadata(
      parentJid,
      '2024-01-01T00:00:01.000Z',
      'Server #general',
      'discord',
      true,
    );
    storeChatMetadata(
      threadJid,
      '2024-01-01T00:00:01.000Z',
      'Thread',
      'discord',
      true,
    );
  });

  it('thread messages without trigger are processed by processGroupMessages logic', () => {
    // Store a message in the thread WITHOUT a trigger
    storeMessage({
      id: 'thread-notrigger-001',
      chat_jid: threadJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: 'thanks, that was helpful',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // Replicate processGroupMessages trigger gate (the patched version)
    const parentJidResolved = resolveParentJid(threadJid);
    const group = registeredGroups[parentJidResolved];
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
    const isThread = !!threadParents[threadJid];

    const missedMessages = getMessagesSince(threadJid, '', 'Andy');
    expect(missedMessages).toHaveLength(1);

    // The patched condition: skip trigger check for threads
    const shouldSkipForTrigger =
      !isMainGroup && !isThread && group.requiresTrigger !== false;
    expect(shouldSkipForTrigger).toBe(false); // Thread → NOT skipped

    // Verify the message would be processed (not silently dropped)
    if (shouldSkipForTrigger) {
      const hasTrigger = missedMessages.some((m) =>
        TRIGGER_PATTERN.test(m.content.trim()),
      );
      // This path should NOT be taken for threads
      expect(hasTrigger).toBe(true);
    }
    // If we get here without entering the if-block, the message is processed ✓
  });

  it('thread messages without trigger are enqueued by message loop logic', () => {
    // Store a message in the thread WITHOUT a trigger
    storeMessage({
      id: 'loop-notrigger-001',
      chat_jid: threadJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: 'can you elaborate on that?',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // Replicate startMessageLoop trigger gate (the patched version)
    const group =
      registeredGroups[threadJid] ||
      registeredGroups[resolveParentJid(threadJid)];
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
    const isThread = !!threadParents[threadJid];
    const needsTrigger =
      !isMainGroup && !isThread && group.requiresTrigger !== false;

    // For threads, needsTrigger should be false — no trigger check applied
    expect(needsTrigger).toBe(false);
  });

  it('non-thread channel messages still require trigger (regression guard)', () => {
    // Store a message in the PARENT channel WITHOUT a trigger
    storeMessage({
      id: 'parent-notrigger-001',
      chat_jid: parentJid,
      sender: 'user2',
      sender_name: 'Bob',
      content: 'just chatting, no trigger here',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // processGroupMessages trigger gate — parent channel is NOT a thread
    const group = registeredGroups[parentJid];
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
    const isThread = !!threadParents[parentJid];

    expect(isThread).toBe(false); // Parent is NOT in threadParents

    const shouldCheckTrigger =
      !isMainGroup && !isThread && group.requiresTrigger !== false;
    expect(shouldCheckTrigger).toBe(true); // Parent channel DOES require trigger

    // The message has no trigger, so it should be silently dropped
    const missedMessages = getMessagesSince(parentJid, '', 'Andy');
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    expect(hasTrigger).toBe(false); // No trigger → message dropped ✓

    // startMessageLoop trigger gate — same result
    const needsTrigger =
      !isMainGroup && !isThread && group.requiresTrigger !== false;
    expect(needsTrigger).toBe(true);
  });
});

/**
 * Integration test: Bot responds in a Discord thread
 *
 * Replays the processGroupMessages logic to verify:
 * 1. When a channel supports sendMessageToThread, output goes to a thread
 * 2. Follow-up outputs from the same agent reuse the same trigger (same thread)
 * 3. When the message is already from a thread, output uses sendMessage (no double-threading)
 * 4. Channels without sendMessageToThread (WhatsApp) use sendMessage as before
 */
describe('Thread reply integration: bot responds in a Discord thread', () => {
  const TRIGGER_PATTERN = /^@Andy\b/i;
  const channelJid = 'dc:5555000000000000';

  // Thread-to-parent mapping (simulates what index.ts maintains)
  const threadParents: Record<string, string> = {};

  const registeredGroups: Record<string, RegisteredGroup> = {
    [channelJid]: {
      name: 'Server #bot',
      folder: 'server-bot',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    },
  };

  function resolveParentJid(jid: string): string {
    return threadParents[jid] || jid;
  }

  /**
   * Simulates processGroupMessages from index.ts — the core routing logic
   * that decides whether to call sendMessageToThread or sendMessage.
   */
  function simulateProcessGroupMessages(
    chatJid: string,
    channel: Channel,
    agentOutputs: string[],
  ): {
    sendMessageCalls: Array<{ jid: string; text: string }>;
    sendMessageToThreadCalls: Array<{
      jid: string;
      text: string;
      triggerMessageId: string;
    }>;
  } {
    const parentJid = resolveParentJid(chatJid);
    const group = registeredGroups[parentJid];
    if (!group) throw new Error(`No group for ${parentJid}`);

    const sinceTimestamp = '';
    const missedMessages = getMessagesSince(chatJid, sinceTimestamp, 'Andy');
    if (missedMessages.length === 0) throw new Error('No messages found');

    // Find trigger message ID (replicates index.ts logic)
    const isAlreadyThread = !!threadParents[chatJid];
    let triggerMessageId: string | undefined;
    if (!isAlreadyThread && channel.sendMessageToThread) {
      const triggerMsg = missedMessages.find((m) =>
        TRIGGER_PATTERN.test(m.content.trim()),
      );
      triggerMessageId = triggerMsg?.id ?? missedMessages[0]?.id;
    }

    // Track calls
    const sendMessageCalls: Array<{ jid: string; text: string }> = [];
    const sendMessageToThreadCalls: Array<{
      jid: string;
      text: string;
      triggerMessageId: string;
    }> = [];

    // Simulate agent producing outputs (replicates the onOutput callback)
    for (const text of agentOutputs) {
      if (triggerMessageId && channel.sendMessageToThread) {
        sendMessageToThreadCalls.push({
          jid: chatJid,
          text,
          triggerMessageId,
        });
      } else {
        sendMessageCalls.push({ jid: chatJid, text });
      }
    }

    return { sendMessageCalls, sendMessageToThreadCalls };
  }

  beforeEach(() => {
    _initTestDatabase();

    // Store chat metadata for the channel
    storeChatMetadata(
      channelJid,
      '2024-01-01T00:00:01.000Z',
      'Server #bot',
      'discord',
      true,
    );
  });

  it('sends output via sendMessageToThread when channel supports it', () => {
    // Store a trigger message in the channel
    storeMessage({
      id: 'msg-trigger-001',
      chat_jid: channelJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy what time is it?',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // Create a Discord-like channel with sendMessageToThread
    const channel: Channel = {
      name: 'discord',
      connect: async () => {},
      sendMessage: vi.fn(),
      sendMessageToThread: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('dc:'),
      disconnect: async () => {},
    };

    const { sendMessageCalls, sendMessageToThreadCalls } =
      simulateProcessGroupMessages(channelJid, channel, ['It is 3:00 PM!']);

    // Should use sendMessageToThread, not sendMessage
    expect(sendMessageToThreadCalls).toHaveLength(1);
    expect(sendMessageToThreadCalls[0]).toEqual({
      jid: channelJid,
      text: 'It is 3:00 PM!',
      triggerMessageId: 'msg-trigger-001',
    });
    expect(sendMessageCalls).toHaveLength(0);
  });

  it('follow-up outputs reuse the same trigger message ID (same thread)', () => {
    storeMessage({
      id: 'msg-trigger-002',
      chat_jid: channelJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy tell me a story',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    const channel: Channel = {
      name: 'discord',
      connect: async () => {},
      sendMessage: vi.fn(),
      sendMessageToThread: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('dc:'),
      disconnect: async () => {},
    };

    // Agent produces multiple outputs (e.g. streaming chunks)
    const { sendMessageToThreadCalls } = simulateProcessGroupMessages(
      channelJid,
      channel,
      ['Once upon a time...', 'The end.'],
    );

    // Both outputs should target the same trigger message ID
    expect(sendMessageToThreadCalls).toHaveLength(2);
    expect(sendMessageToThreadCalls[0].triggerMessageId).toBe(
      'msg-trigger-002',
    );
    expect(sendMessageToThreadCalls[1].triggerMessageId).toBe(
      'msg-trigger-002',
    );
  });

  it('uses the trigger message ID, not the first message, when trigger is not first', () => {
    // Context message (no trigger)
    storeMessage({
      id: 'msg-context-001',
      chat_jid: channelJid,
      sender: 'user2',
      sender_name: 'Bob',
      content: 'Hey everyone',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // Trigger message (second in batch)
    storeMessage({
      id: 'msg-trigger-003',
      chat_jid: channelJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy what do you think?',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    const channel: Channel = {
      name: 'discord',
      connect: async () => {},
      sendMessage: vi.fn(),
      sendMessageToThread: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('dc:'),
      disconnect: async () => {},
    };

    const { sendMessageToThreadCalls } = simulateProcessGroupMessages(
      channelJid,
      channel,
      ['I think...'],
    );

    // Thread should be created from the trigger message, not the context message
    expect(sendMessageToThreadCalls[0].triggerMessageId).toBe(
      'msg-trigger-003',
    );
  });

  it('falls back to sendMessage when message is already from a thread', () => {
    const threadJid = 'dc:7777000000000000';
    threadParents[threadJid] = channelJid;

    storeChatMetadata(
      threadJid,
      '2024-01-01T00:00:01.000Z',
      'Thread',
      'discord',
      true,
    );

    storeMessage({
      id: 'msg-thread-001',
      chat_jid: threadJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy follow up question',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    const channel: Channel = {
      name: 'discord',
      connect: async () => {},
      sendMessage: vi.fn(),
      sendMessageToThread: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('dc:'),
      disconnect: async () => {},
    };

    const { sendMessageCalls, sendMessageToThreadCalls } =
      simulateProcessGroupMessages(threadJid, channel, ['Here is the answer']);

    // Should use sendMessage (no double-threading), not sendMessageToThread
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toEqual({
      jid: threadJid,
      text: 'Here is the answer',
    });
    expect(sendMessageToThreadCalls).toHaveLength(0);

    // Cleanup
    delete threadParents[threadJid];
  });

  it('uses sendMessage for channels without sendMessageToThread (WhatsApp)', () => {
    const waJid = 'wa:1234567890@g.us';
    registeredGroups[waJid] = {
      name: 'WhatsApp Group',
      folder: 'wa-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    };

    storeChatMetadata(
      waJid,
      '2024-01-01T00:00:01.000Z',
      'WA Group',
      'whatsapp',
      true,
    );

    storeMessage({
      id: 'msg-wa-001',
      chat_jid: waJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy hello',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // WhatsApp channel — no sendMessageToThread
    const channel: Channel = {
      name: 'whatsapp',
      connect: async () => {},
      sendMessage: vi.fn(),
      // No sendMessageToThread
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('wa:'),
      disconnect: async () => {},
    };

    const { sendMessageCalls, sendMessageToThreadCalls } =
      simulateProcessGroupMessages(waJid, channel, ['Hello Alice!']);

    // Should use sendMessage (no threading support)
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toEqual({
      jid: waJid,
      text: 'Hello Alice!',
    });
    expect(sendMessageToThreadCalls).toHaveLength(0);

    // Cleanup
    delete registeredGroups[waJid];
  });

  it('end-to-end: GroupQueue processes channel message and routes to thread', async () => {
    vi.useFakeTimers();

    storeMessage({
      id: 'msg-e2e-001',
      chat_jid: channelJid,
      sender: 'user1',
      sender_name: 'Alice',
      content: '@Andy summarize this',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    // Track routing decisions
    const routingLog: Array<{
      method: 'sendMessage' | 'sendMessageToThread';
      jid: string;
      text: string;
      triggerMessageId?: string;
    }> = [];

    const channel: Channel = {
      name: 'discord',
      connect: async () => {},
      sendMessage: vi.fn(),
      sendMessageToThread: vi.fn(),
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('dc:'),
      disconnect: async () => {},
    };

    const queue = new GroupQueue();
    queue.setResolveGroupJidFn(resolveParentJid);

    const lastAgentTimestamp: Record<string, string> = {};

    const processGroupMessages = async (chatJid: string): Promise<boolean> => {
      const parentJid = resolveParentJid(chatJid);
      const group = registeredGroups[parentJid];
      if (!group) return true;

      const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
      const missedMessages = getMessagesSince(chatJid, sinceTimestamp, 'Andy');
      if (missedMessages.length === 0) return true;

      // Trigger message ID logic (from index.ts)
      const isAlreadyThread = !!threadParents[chatJid];
      let triggerMessageId: string | undefined;
      if (!isAlreadyThread && channel.sendMessageToThread) {
        const triggerMsg = missedMessages.find((m) =>
          TRIGGER_PATTERN.test(m.content.trim()),
        );
        triggerMessageId = triggerMsg?.id ?? missedMessages[0]?.id;
      }

      // Simulate agent output
      const agentResponse = 'Here is the summary...';

      if (triggerMessageId && channel.sendMessageToThread) {
        routingLog.push({
          method: 'sendMessageToThread',
          jid: chatJid,
          text: agentResponse,
          triggerMessageId,
        });
      } else {
        routingLog.push({
          method: 'sendMessage',
          jid: chatJid,
          text: agentResponse,
        });
      }

      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      return true;
    };

    queue.setProcessMessagesFn(processGroupMessages);
    queue.enqueueMessageCheck(channelJid);

    await vi.advanceTimersByTimeAsync(100);

    // Verify the output was routed to a thread
    expect(routingLog).toHaveLength(1);
    expect(routingLog[0]).toEqual({
      method: 'sendMessageToThread',
      jid: channelJid,
      text: 'Here is the summary...',
      triggerMessageId: 'msg-e2e-001',
    });

    vi.useRealTimers();
  });
});

/**
 * Integration test: Thread self-healing
 *
 * Tests the self-healing logic that cleans up incorrectly registered thread JIDs
 * and prevents future incorrect registrations.
 */
describe('Thread self-healing', () => {
  const parentJid = 'dc:8000000000000000';
  const threadJid = 'dc:8000111111111111';

  // Simulated in-memory state (mirrors index.ts)
  let registeredGroups: Record<string, RegisteredGroup>;
  let threadParents: Record<string, string>;

  beforeEach(() => {
    _initTestDatabase();
    registeredGroups = {};
    threadParents = {};
  });

  /**
   * Simulates the onThreadMapping callback from index.ts
   * (with self-healing logic)
   */
  function onThreadMapping(threadJid: string, parentJid: string): void {
    threadParents[threadJid] = parentJid;
    if (registeredGroups[threadJid]) {
      delete registeredGroups[threadJid];
      deleteRegisteredGroup(threadJid);
    }
  }

  /**
   * Simulates the registerGroup guard from index.ts
   */
  function registerGroup(jid: string, group: RegisteredGroup): boolean {
    if (threadParents[jid]) {
      return false; // Rejected
    }
    registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    return true;
  }

  function resolveParentJid(jid: string): string {
    return threadParents[jid] || jid;
  }

  it('onThreadMapping removes incorrectly registered thread from registeredGroups and DB', () => {
    // Setup: thread JID is incorrectly registered as its own group
    const badGroup: RegisteredGroup = {
      name: 'Thread as group',
      folder: 'dc-thread-as-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    registeredGroups[threadJid] = badGroup;
    setRegisteredGroup(threadJid, badGroup);

    // Also register the real parent
    const parentGroup: RegisteredGroup = {
      name: 'Parent Channel',
      folder: 'dc-parent-channel',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    registeredGroups[parentJid] = parentGroup;
    setRegisteredGroup(parentJid, parentGroup);

    // Act: a thread message arrives, triggering onThreadMapping
    onThreadMapping(threadJid, parentJid);

    // Assert: thread is removed from in-memory map
    expect(registeredGroups[threadJid]).toBeUndefined();

    // Assert: thread is removed from DB
    const allGroups = getAllRegisteredGroups();
    expect(allGroups[threadJid]).toBeUndefined();

    // Assert: parent is still registered
    expect(registeredGroups[parentJid]).toBeDefined();
    expect(allGroups[parentJid]).toBeDefined();

    // Assert: thread-to-parent mapping is set
    expect(threadParents[threadJid]).toBe(parentJid);
  });

  it('after self-healing, messages route via parent group correctly', () => {
    // Setup: register parent group
    const parentGroup: RegisteredGroup = {
      name: 'Parent Channel',
      folder: 'dc-parent-channel',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    registeredGroups[parentJid] = parentGroup;
    setRegisteredGroup(parentJid, parentGroup);

    // Thread was incorrectly registered
    registeredGroups[threadJid] = {
      name: 'Bad thread group',
      folder: 'dc-bad-thread-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    setRegisteredGroup(threadJid, {
      name: 'Bad thread group',
      folder: 'dc-bad-thread-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Self-heal
    onThreadMapping(threadJid, parentJid);

    // Now resolve the thread JID — should go to parent
    const resolved = resolveParentJid(threadJid);
    expect(resolved).toBe(parentJid);

    // Lookup group via resolved parent
    const group = registeredGroups[resolved];
    expect(group).toBeDefined();
    expect(group!.folder).toBe('dc-parent-channel');
  });

  it('registerGroup rejects registration of known thread JIDs', () => {
    // Setup: establish thread mapping first
    threadParents[threadJid] = parentJid;

    // Try to register the thread JID as a group
    const result = registerGroup(threadJid, {
      name: 'Should be rejected',
      folder: 'dc-should-be-rejected',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Should be rejected
    expect(result).toBe(false);
    expect(registeredGroups[threadJid]).toBeUndefined();
  });
});
