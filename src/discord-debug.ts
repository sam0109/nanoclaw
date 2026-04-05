/**
 * Discord Debug CLI Tool
 *
 * Standalone CLI script for inspecting Discord state and sending test messages.
 * Useful for diagnosing thread routing issues.
 *
 * Usage: npx tsx src/discord-debug.ts <command> [args]
 *
 * Commands:
 *   guilds                          List all guilds the bot is in
 *   channels <guildId>              List text channels in a guild
 *   threads <channelId>             List active + recently archived threads
 *   messages <channelId> [count]    Fetch recent messages (default 10)
 *   info <channelId>                Detailed channel/thread info
 *   db                              Show Discord chats from SQLite DB
 *   send <channelId> <text>         Send a message to a channel or thread
 *   thread <channelId> <msgId> <text>  Create thread from message and send text
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { DISCORD_BOT_TOKEN } from './config.js';
import { getAllChats, getAllRegisteredGroups, initDatabase } from './db.js';

const USAGE = `
Usage: npx tsx src/discord-debug.ts <command> [args]

Commands:
  guilds                             List all guilds the bot is in
  channels <guildId>                 List text channels in a guild
  threads <channelId>                List active + recently archived threads
  messages <channelId> [count=10]    Fetch recent messages from a channel or thread
  info <channelId>                   Detailed channel/thread info
  db                                 Show Discord chats from SQLite DB
  send <channelId> <text>            Send a message to a channel or thread
  thread <channelId> <msgId> <text>  Create a thread from a message and send text
`.trim();

function channelTypeName(type: ChannelType): string {
  const names: Record<number, string> = {
    [ChannelType.GuildText]: 'GuildText',
    [ChannelType.DM]: 'DM',
    [ChannelType.GuildVoice]: 'GuildVoice',
    [ChannelType.GroupDM]: 'GroupDM',
    [ChannelType.GuildCategory]: 'GuildCategory',
    [ChannelType.GuildAnnouncement]: 'GuildAnnouncement',
    [ChannelType.AnnouncementThread]: 'AnnouncementThread',
    [ChannelType.PublicThread]: 'PublicThread',
    [ChannelType.PrivateThread]: 'PrivateThread',
    [ChannelType.GuildStageVoice]: 'GuildStageVoice',
    [ChannelType.GuildDirectory]: 'GuildDirectory',
    [ChannelType.GuildForum]: 'GuildForum',
    [ChannelType.GuildMedia]: 'GuildMedia',
  };
  return names[type] || `Unknown(${type})`;
}

async function connectClient(): Promise<Client> {
  if (!DISCORD_BOT_TOKEN) {
    console.error('Error: DISCORD_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  return new Promise<Client>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Timed out waiting for Discord client to be ready'));
    }, 15000);

    client.once(Events.ClientReady, (readyClient: Client<true>) => {
      clearTimeout(timeout);
      console.log(`Connected as ${readyClient.user.tag}\n`);
      resolve(client);
    });

    client.once(Events.Error, (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.login(DISCORD_BOT_TOKEN);
  });
}

async function cmdGuilds(client: Client): Promise<void> {
  const guilds = client.guilds.cache;
  if (guilds.size === 0) {
    console.log('Bot is not in any guilds.');
    return;
  }

  console.log(`Guilds (${guilds.size}):`);
  console.log('─'.repeat(70));
  for (const guild of guilds.values()) {
    console.log(
      `  ${guild.id}  ${guild.name.padEnd(30)}  members: ${guild.memberCount}`,
    );
  }
}

async function cmdChannels(client: Client, guildId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error(`Guild ${guildId} not found. Use 'guilds' to list guilds.`);
    process.exit(1);
  }

  const channels = guild.channels.cache
    .filter(
      (ch): ch is TextChannel =>
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement ||
        ch.type === ChannelType.GuildForum ||
        ch.type === ChannelType.GuildMedia,
    )
    .sort((a: TextChannel, b: TextChannel) => (a.position ?? 0) - (b.position ?? 0));

  console.log(`Text channels in "${guild.name}" (${channels.size}):`);
  console.log('─'.repeat(80));
  console.log(
    `  ${'ID'.padEnd(20)}  ${'Name'.padEnd(25)}  ${'Type'.padEnd(20)}  Parent`,
  );
  console.log('─'.repeat(80));
  for (const ch of channels.values()) {
    console.log(
      `  ${ch.id.padEnd(20)}  ${('#' + ch.name).padEnd(25)}  ${channelTypeName(ch.type).padEnd(20)}  ${ch.parentId || '—'}`,
    );
  }
}

async function cmdThreads(client: Client, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    console.error(`Channel ${channelId} not found.`);
    process.exit(1);
  }

  if (!('threads' in channel)) {
    console.error(
      `Channel ${channelId} (${channelTypeName(channel.type)}) does not support threads.`,
    );
    process.exit(1);
  }

  const textChannel = channel as TextChannel;

  // Fetch active threads
  const active = await textChannel.threads.fetchActive();
  // Fetch recently archived threads
  const archived = await textChannel.threads.fetchArchived({ limit: 20 });

  const allThreads = new Map([...active.threads, ...archived.threads]);

  if (allThreads.size === 0) {
    console.log(`No threads found in #${textChannel.name}.`);
    return;
  }

  console.log(
    `Threads in #${textChannel.name} (${allThreads.size} active + archived):`,
  );
  console.log('─'.repeat(90));
  console.log(
    `  ${'ID'.padEnd(20)}  ${'Name'.padEnd(30)}  ${'Type'.padEnd(18)}  ${'Archived'.padEnd(10)}  Parent`,
  );
  console.log('─'.repeat(90));
  for (const thread of allThreads.values() as IterableIterator<ThreadChannel>) {
    console.log(
      `  ${thread.id.padEnd(20)}  ${(thread.name || '(unnamed)').padEnd(30)}  ${channelTypeName(thread.type).padEnd(18)}  ${(thread.archived ? 'yes' : 'no').padEnd(10)}  ${thread.parentId || '—'}`,
    );
  }
}

async function cmdMessages(
  client: Client,
  channelId: string,
  count: number,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    console.error(`Channel ${channelId} not found.`);
    process.exit(1);
  }

  if (!('messages' in channel)) {
    console.error(
      `Channel ${channelId} (${channelTypeName(channel.type)}) does not support messages.`,
    );
    process.exit(1);
  }

  const textChannel = channel as TextChannel;
  const messages = await textChannel.messages.fetch({ limit: count });

  const isThread =
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread;
  const label = isThread
    ? `thread "${textChannel.name}" (parent: ${(channel as any).parentId})`
    : `#${textChannel.name}`;

  console.log(`Last ${messages.size} messages in ${label}:`);
  console.log('─'.repeat(90));

  // Print in chronological order (oldest first)
  const sorted = [...messages.values()].reverse();
  for (const msg of sorted) {
    const time = msg.createdAt.toISOString().slice(0, 19).replace('T', ' ');
    const author = msg.author.bot ? `[BOT] ${msg.author.tag}` : msg.author.tag;
    const preview = msg.content.slice(0, 120).replace(/\n/g, '↵');
    const threadInfo = msg.thread ? ` [has thread: ${msg.thread.id}]` : '';
    console.log(`  ${time}  ${msg.id}  ${author}`);
    console.log(`    ${preview}${threadInfo}`);
  }
}

async function cmdInfo(client: Client, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    console.error(`Channel ${channelId} not found.`);
    process.exit(1);
  }

  console.log('Channel info:');
  console.log('─'.repeat(50));
  console.log(`  ID:        ${channel.id}`);
  console.log(`  Type:      ${channelTypeName(channel.type)}`);

  if ('name' in channel) {
    console.log(`  Name:      ${(channel as TextChannel).name}`);
  }

  const isThread =
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread;

  console.log(`  isThread:  ${isThread}`);

  if ('parentId' in channel) {
    console.log(`  ParentID:  ${(channel as TextChannel).parentId || '—'}`);
  }

  if ('guild' in channel && (channel as TextChannel).guild) {
    const guild = (channel as TextChannel).guild;
    console.log(`  Guild:     ${guild.name} (${guild.id})`);
  }

  if (isThread && 'archived' in channel) {
    console.log(`  Archived:  ${(channel as any).archived}`);
  }

  console.log(`  JID:       dc:${channel.id}`);

  // Check if this channel or its parent is registered
  try {
    initDatabase();
    const groups = getAllRegisteredGroups();
    const directReg = groups[`dc:${channel.id}`];
    if (directReg) {
      console.log(
        `  Registered: YES (folder: ${directReg.folder}, trigger: ${directReg.trigger})`,
      );
    } else if (isThread && 'parentId' in channel) {
      const parentId = (channel as any).parentId as string | null;
      const parentReg = parentId ? groups[`dc:${parentId}`] : undefined;
      if (parentReg) {
        console.log(
          `  Registered: via parent dc:${parentId} (folder: ${parentReg.folder})`,
        );
      } else {
        console.log(`  Registered: NO`);
      }
    } else {
      console.log(`  Registered: NO`);
    }
  } catch {
    // DB might not be initialized — skip registration info
  }
}

function cmdDb(): void {
  try {
    initDatabase();
  } catch (err) {
    console.error('Failed to open database:', err);
    process.exit(1);
  }

  // Discord chats
  const allChats = getAllChats();
  const discordChats = allChats.filter((c) => c.jid.startsWith('dc:'));

  console.log(`Discord chats in DB (${discordChats.length}):`);
  console.log('─'.repeat(80));
  if (discordChats.length > 0) {
    console.log(`  ${'JID'.padEnd(25)}  ${'Name'.padEnd(30)}  Last message`);
    console.log('─'.repeat(80));
    for (const chat of discordChats) {
      console.log(
        `  ${chat.jid.padEnd(25)}  ${(chat.name || '—').padEnd(30)}  ${chat.last_message_time || '—'}`,
      );
    }
  }

  // Registered groups
  const groups = getAllRegisteredGroups();
  const discordGroups = Object.entries(groups).filter(([jid]) =>
    jid.startsWith('dc:'),
  );

  console.log(`\nRegistered Discord groups (${discordGroups.length}):`);
  console.log('─'.repeat(90));
  if (discordGroups.length > 0) {
    console.log(
      `  ${'JID'.padEnd(25)}  ${'Name'.padEnd(25)}  ${'Folder'.padEnd(20)}  Trigger`,
    );
    console.log('─'.repeat(90));
    for (const [jid, group] of discordGroups) {
      console.log(
        `  ${jid.padEnd(25)}  ${(group.name || '—').padEnd(25)}  ${group.folder.padEnd(20)}  ${group.trigger}`,
      );
    }
  }
}

async function cmdSend(
  client: Client,
  channelId: string,
  text: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    console.error(`Channel ${channelId} not found.`);
    process.exit(1);
  }

  if (!('send' in channel)) {
    console.error(
      `Channel ${channelId} (${channelTypeName(channel.type)}) is not text-based.`,
    );
    process.exit(1);
  }

  const textChannel = channel as TextChannel;
  const sent = await textChannel.send(text);
  console.log(`Message sent to #${textChannel.name}: ${sent.id}`);
}

async function cmdThread(
  client: Client,
  channelId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    console.error(`Channel ${channelId} not found.`);
    process.exit(1);
  }

  if (!('threads' in channel)) {
    console.error(
      `Channel ${channelId} (${channelTypeName(channel.type)}) does not support threads.`,
    );
    process.exit(1);
  }

  const textChannel = channel as TextChannel;
  const threadName = text.slice(0, 90).replace(/\n/g, ' ').trim() || 'Debug';
  const thread = await textChannel.threads.create({
    startMessage: messageId,
    name: threadName,
  });

  const sent = await thread.send(text);
  console.log(
    `Thread created: ${thread.id} (name: "${thread.name}") from message ${messageId}`,
  );
  console.log(`Message sent in thread: ${sent.id}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // `db` command doesn't need Discord connection
  if (command === 'db') {
    cmdDb();
    process.exit(0);
  }

  const client = await connectClient();

  try {
    switch (command) {
      case 'guilds':
        await cmdGuilds(client);
        break;

      case 'channels': {
        const guildId = args[0];
        if (!guildId) {
          console.error('Usage: channels <guildId>');
          process.exit(1);
        }
        await cmdChannels(client, guildId);
        break;
      }

      case 'threads': {
        const channelId = args[0];
        if (!channelId) {
          console.error('Usage: threads <channelId>');
          process.exit(1);
        }
        await cmdThreads(client, channelId);
        break;
      }

      case 'messages': {
        const channelId = args[0];
        if (!channelId) {
          console.error('Usage: messages <channelId> [count=10]');
          process.exit(1);
        }
        const count = parseInt(args[1] || '10', 10);
        await cmdMessages(client, channelId, count);
        break;
      }

      case 'info': {
        const channelId = args[0];
        if (!channelId) {
          console.error('Usage: info <channelId>');
          process.exit(1);
        }
        await cmdInfo(client, channelId);
        break;
      }

      case 'send': {
        const channelId = args[0];
        const text = args.slice(1).join(' ');
        if (!channelId || !text) {
          console.error('Usage: send <channelId> <text>');
          process.exit(1);
        }
        await cmdSend(client, channelId, text);
        break;
      }

      case 'thread': {
        const channelId = args[0];
        const messageId = args[1];
        const text = args.slice(2).join(' ');
        if (!channelId || !messageId || !text) {
          console.error('Usage: thread <channelId> <messageId> <text>');
          process.exit(1);
        }
        await cmdThread(client, channelId, messageId, text);
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    client.destroy();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
