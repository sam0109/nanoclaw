import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
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

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Thread concurrency with resolveGroupJid ---

  describe('resolveGroupJid thread support', () => {
    it('two thread JIDs mapping to same parent share queue state', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async (groupJid: string) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        concurrentCount--;
        return true;
      });

      // Both thread JIDs resolve to the same parent
      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1' || jid === 'dc:thread-2')
          return 'dc:parent-channel';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Enqueue two different thread JIDs
      queue.enqueueMessageCheck('dc:thread-1');
      queue.enqueueMessageCheck('dc:thread-2');

      await vi.advanceTimersByTimeAsync(10);

      // Only one should be running (they share the same parent state)
      expect(maxConcurrent).toBe(1);

      // First call should receive the original thread JID, not the resolved parent
      expect(processMessages).toHaveBeenNthCalledWith(1, 'dc:thread-1');

      // Complete the first — the second should now run
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(2);
      // Second call should receive the second thread JID
      expect(processMessages).toHaveBeenNthCalledWith(2, 'dc:thread-2');
    });

    it('sendMessage uses resolved group state (finds active container via parent)', async () => {
      const fs = await import('fs');
      let resolveProcess: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1') return 'dc:parent-channel';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start processing via the parent
      queue.enqueueMessageCheck('dc:parent-channel');
      await vi.advanceTimersByTimeAsync(10);

      // Register process with groupFolder
      queue.registerProcess(
        'dc:parent-channel',
        {} as any,
        'container-1',
        'parent-folder',
      );

      // sendMessage via thread JID should find the parent's active container
      const result = queue.sendMessage('dc:thread-1', 'hello from thread');
      expect(result).toBe(true);

      // Verify IPC file is written to the parent's groupFolder
      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      const ipcWrites = writeFileSync.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('parent-folder'),
      );
      expect(ipcWrites.length).toBeGreaterThan(0);

      resolveProcess!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('resolveGroupJid defaults to identity (existing behavior preserved)', async () => {
      const processMessages = vi.fn(async () => true);
      queue.setProcessMessagesFn(processMessages);

      // No setResolveGroupJidFn call — default identity
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledWith('group1@g.us');
    });

    it('thread JIDs queued at concurrency limit are drained with original JIDs', async () => {
      const completionCallbacks: Array<() => void> = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid.startsWith('dc:thread-')) return 'dc:parent';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Fill both concurrency slots with unrelated groups
      queue.enqueueMessageCheck('group-a@g.us');
      queue.enqueueMessageCheck('group-b@g.us');
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(2);

      // Enqueue thread JID while at concurrency limit — should be queued
      queue.enqueueMessageCheck('dc:thread-1');
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(2); // still 2

      // Free up a slot — thread should start with original thread JID
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledTimes(3);
      expect(processMessages).toHaveBeenNthCalledWith(3, 'dc:thread-1');

      // Cleanup
      completionCallbacks[1]();
      completionCallbacks[2]();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('multiple thread JIDs from same parent accumulate and drain sequentially', async () => {
      const completionCallbacks: Array<() => void> = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid.startsWith('dc:thread-')) return 'dc:parent';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start thread-1 (takes the parent's active slot)
      queue.enqueueMessageCheck('dc:thread-1');
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(1);
      expect(processMessages).toHaveBeenNthCalledWith(1, 'dc:thread-1');

      // While thread-1 is active, enqueue thread-2 and thread-3
      queue.enqueueMessageCheck('dc:thread-2');
      queue.enqueueMessageCheck('dc:thread-3');

      // Complete thread-1 — thread-2 should drain next
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(2);
      expect(processMessages).toHaveBeenNthCalledWith(2, 'dc:thread-2');

      // Complete thread-2 — thread-3 should drain
      completionCallbacks[1]();
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(3);
      expect(processMessages).toHaveBeenNthCalledWith(3, 'dc:thread-3');

      // Cleanup
      completionCallbacks[2]();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('notifyIdle via thread JID resolves to parent state', async () => {
      const fs = await import('fs');
      let resolveProcess: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1') return 'dc:parent';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start via thread-1
      queue.enqueueMessageCheck('dc:thread-1');
      await vi.advanceTimersByTimeAsync(10);

      // Register process with parent JID
      queue.registerProcess(
        'dc:parent',
        {} as any,
        'container-1',
        'parent-folder',
      );

      // Enqueue a task for the parent
      const taskFn = vi.fn(async () => {});
      queue.enqueueTask('dc:parent', 'task-1', taskFn);

      // notifyIdle via thread JID — should resolve to parent and trigger preemption
      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      writeFileSync.mockClear();
      queue.notifyIdle('dc:thread-1');

      const closeWrites = writeFileSync.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeWrites).toHaveLength(1);

      resolveProcess!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('task enqueued via thread JID shares state with parent', async () => {
      const executionOrder: string[] = [];
      let resolveProcess: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        executionOrder.push('messages');
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1') return 'dc:parent';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start processing via parent
      queue.enqueueMessageCheck('dc:parent');
      await vi.advanceTimersByTimeAsync(10);

      // Enqueue task via thread JID — should queue on parent's state
      const taskFn = vi.fn(async () => {
        executionOrder.push('task');
      });
      queue.enqueueTask('dc:thread-1', 'task-1', taskFn);

      // Task should not run yet (parent has active container)
      expect(taskFn).not.toHaveBeenCalled();

      // Complete the message processing — task should drain
      resolveProcess!();
      await vi.advanceTimersByTimeAsync(10);

      expect(executionOrder).toEqual(['messages', 'task']);
    });

    it('sendMessage via thread JID returns false when parent has task container', async () => {
      let resolveTask: () => void;

      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1') return 'dc:parent';
        return jid;
      });

      const taskFn = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveTask = resolve;
        });
      });

      // Start a task via parent (sets isTaskContainer = true)
      queue.enqueueTask('dc:parent', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);
      queue.registerProcess(
        'dc:parent',
        {} as any,
        'container-1',
        'parent-folder',
      );

      // sendMessage via thread should return false (task container)
      const result = queue.sendMessage('dc:thread-1', 'hello');
      expect(result).toBe(false);

      resolveTask!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('thread and parent enqueues interleave correctly', async () => {
      const completionCallbacks: Array<() => void> = [];
      const calledWith: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        calledWith.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      queue.setResolveGroupJidFn((jid) => {
        if (jid === 'dc:thread-1' || jid === 'dc:thread-2') return 'dc:parent';
        return jid;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start via parent directly
      queue.enqueueMessageCheck('dc:parent');
      await vi.advanceTimersByTimeAsync(10);
      expect(calledWith).toEqual(['dc:parent']);

      // While parent container is active, enqueue from thread-1 and then parent again
      queue.enqueueMessageCheck('dc:thread-1');
      queue.enqueueMessageCheck('dc:parent');

      // Complete — drain should pick up thread-1's original JID
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      // Should drain with one of the pending JIDs (thread-1 was enqueued first)
      expect(calledWith).toHaveLength(2);
      expect(calledWith[1]).toBe('dc:thread-1');

      // Cleanup
      completionCallbacks[1]();
      await vi.advanceTimersByTimeAsync(10);
    });
  });
});
