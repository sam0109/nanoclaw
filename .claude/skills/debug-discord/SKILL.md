---
name: debug-discord
description: Debug Discord integration issues — thread routing, channel registration, message delivery. Use when Discord messages land in the wrong thread, threads aren't created, or messages aren't being routed correctly.
triggers:
  - debug.?discord
  - discord.?debug
  - discord.?thread
  - thread.?routing
---

# Discord Debug Guide

Diagnose Discord integration issues using the `discord-debug` CLI tool and log/DB inspection.

## The Debug CLI Tool

Run via npm script or directly:
```bash
npm run discord-debug -- <command> [args]
# or
npx tsx src/discord-debug.ts <command> [args]
```

### Command Reference

| Command | Description |
|---------|-------------|
| `guilds` | List all guilds the bot is in (id, name, member count) |
| `channels <guildId>` | List text channels in a guild (id, name, type, parentId) |
| `threads <channelId>` | List active + recently archived threads in a channel |
| `messages <channelId> [count=10]` | Fetch recent messages from a channel or thread |
| `info <channelId>` | Detailed channel/thread info (type, parentId, isThread, registration status) |
| `db` | Show Discord chats and registered groups from SQLite |
| `send <channelId> <text>` | Send a message to a channel or thread as the bot |
| `thread <channelId> <msgId> <text>` | Create a thread from a message and send text into it |

### Typical Workflow

Start broad, then drill down:

```bash
# 1. Find the guild
npm run discord-debug -- guilds

# 2. List channels in that guild
npm run discord-debug -- channels <guildId>

# 3. List threads in the channel with issues
npm run discord-debug -- threads <channelId>

# 4. Check what the bot sees in a specific thread
npm run discord-debug -- messages <threadId> 20

# 5. Inspect channel/thread metadata
npm run discord-debug -- info <channelId>
npm run discord-debug -- info <threadId>

# 6. Check DB state — registered groups, chat JIDs
npm run discord-debug -- db
```

## Thread Routing Architecture

Understanding how Discord threads are routed is critical for debugging.

### How messages flow

```
Discord thread message
    │
    ▼
DiscordChannel.onMessage()
    │
    ├── chatJid = dc:<threadChannelId>     ← unique per thread
    ├── groupLookupJid = dc:<parentId>     ← shared registration
    └── onThreadMapping(chatJid, parentJid) ← stored in memory
    │
    ▼
index.ts message loop
    │
    ├── resolveParentJid(chatJid) → finds the parent channel's group
    ├── Uses parent's folder, session, CLAUDE.md
    └── Queries messages by chatJid (thread-level history isolation)
    │
    ▼
Response routing
    │
    ├── If chatJid is already a thread → send directly to dc:<threadId>
    └── If chatJid is a channel → create new thread from trigger message
```

### Key data structures

| Where | What | Example |
|-------|------|---------|
| `threadParents` (in-memory, index.ts) | `threadJid → parentJid` | `dc:1234 → dc:5678` |
| `registered_groups` (SQLite) | Parent channels only | `dc:5678 → {folder: "dc-myserver-general"}` |
| `chats` (SQLite) | Both channels and threads | `dc:1234` and `dc:5678` as separate entries |

### Common thread routing bugs

1. **Thread parent not in `threadParents` map** — The map is in-memory only; it's populated when messages arrive. After a restart, the map is empty until the first message from each thread.

2. **Thread registered as its own group** — If a thread got auto-registered before the parent mapping was established, it has its own folder instead of sharing the parent's.

3. **Wrong `parentId`** — Discord sometimes returns unexpected parent chains for nested threads or forum posts.

## Debugging Procedures

### Problem: All threads go to same group/response

**Step 1:** Check DB state for duplicate or wrong registrations:
```bash
npm run discord-debug -- db
```
Look for thread JIDs (`dc:<threadId>`) that appear in the registered groups table. Threads should NOT be registered — only parent channels should be.

**Step 2:** Compare channel vs thread IDs:
```bash
# Check the parent channel
npm run discord-debug -- info <parentChannelId>

# Check the thread
npm run discord-debug -- info <threadId>
```
Verify the thread's `parentId` matches the registered channel.

**Step 3:** Check message routing in logs:
```bash
grep "Discord message stored" logs/nanoclaw.log | tail -20
```
Each log entry shows `chatJid` — verify different threads produce different `chatJid` values.

**Step 4:** Check if `threadParents` mapping is being set:
```bash
grep "onThreadMapping\|threadParent" logs/nanoclaw.log | tail -10
```

### Problem: Bot doesn't respond in threads

**Step 1:** Verify the parent channel is registered:
```bash
npm run discord-debug -- info <parentChannelId>
# Should show "Registered: YES"
```

**Step 2:** Check if messages from the thread are being stored:
```bash
sqlite3 store/messages.db "SELECT id, chat_jid, sender_name, content FROM messages WHERE chat_jid = 'dc:<threadId>' ORDER BY timestamp DESC LIMIT 5"
```

**Step 3:** Check if the thread JID is in the polled JID list. The message loop polls both registered group JIDs and known thread JIDs. If the bot restarted since the thread was active, the thread won't be in the in-memory map until a new message arrives.

### Problem: Bot creates new thread instead of replying in existing one

This happens when `sendMessageToThread` is called with a channel JID (not a thread JID). The code checks `isAlreadyThread` — if the message came from a thread, it sends directly to that thread. If not, it creates a new one.

**Check:** Verify the `chatJid` in the response routing includes the thread ID:
```bash
grep "sending response\|sendMessage" logs/nanoclaw.log | tail -10
```

### Problem: Messages not arriving at all

**Step 1:** Verify the bot can see the channel:
```bash
npm run discord-debug -- messages <channelId> 5
```

**Step 2:** Check the bot has required intents enabled in the Discord Developer Portal:
- `SERVER MEMBERS INTENT` — for member info
- `MESSAGE CONTENT INTENT` — required for reading message content
- `PRESENCE INTENT` — not required but may help

**Step 3:** Test sending as the bot:
```bash
npm run discord-debug -- send <channelId> "debug test"
```

## Direct DB Queries

For deeper investigation beyond what `db` command shows:

```bash
# All Discord messages, most recent first
sqlite3 store/messages.db "SELECT chat_jid, sender_name, substr(content, 1, 60), timestamp FROM messages WHERE chat_jid LIKE 'dc:%' ORDER BY timestamp DESC LIMIT 20"

# Messages grouped by chat_jid (are threads getting separate JIDs?)
sqlite3 store/messages.db "SELECT chat_jid, COUNT(*) as msg_count, MAX(timestamp) as last_msg FROM messages WHERE chat_jid LIKE 'dc:%' GROUP BY chat_jid ORDER BY last_msg DESC"

# Check if any threads are incorrectly registered as groups
sqlite3 store/messages.db "SELECT rg.jid, rg.name, rg.folder FROM registered_groups rg WHERE rg.jid LIKE 'dc:%'"

# Remove an incorrectly registered thread (use with caution)
# sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid = 'dc:<threadId>'"
```

## Sending Test Messages

Use `send` and `thread` commands to reproduce issues:

```bash
# Send a message to a channel (bot will appear as itself)
npm run discord-debug -- send <channelId> "Testing from debug CLI"

# Create a thread from a specific message
npm run discord-debug -- thread <channelId> <messageId> "Thread test from debug CLI"

# Send into an existing thread
npm run discord-debug -- send <threadId> "Reply in existing thread"
```

## Key Source Files

| File | What to look at |
|------|----------------|
| `src/channels/discord.ts` | `onMessage` handler — thread detection, JID construction, `onThreadMapping` call |
| `src/index.ts` | `threadParents` map, `resolveParentJid()`, message loop JID polling, response routing |
| `src/discord-debug.ts` | The debug CLI tool itself |
| `src/db.ts` | `getAllChats()`, `getAllRegisteredGroups()` — DB queries |
