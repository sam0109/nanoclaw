import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onThreadMapping?: (threadJid: string, parentJid: string) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  // Thread cache: "channelId:triggerMessageId" → threadChannelId
  private threadCache = new Map<string, string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Thread detection — threads share their parent channel's group
      const isThread = message.channel.isThread();
      let groupLookupJid = chatJid; // JID used for group registration/lookup
      if (isThread && message.channel.parentId) {
        const parentJid = `dc:${message.channel.parentId}`;
        groupLookupJid = parentJid;
        this.opts.onThreadMapping?.(chatJid, parentJid);
      }

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Auto-register unknown Discord channels on first message
      // Threads use the parent channel's registration
      let group = this.opts.registeredGroups()[groupLookupJid];
      if (!group && this.opts.onRegisterGroup) {
        const folderName = chatName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        group = {
          name: chatName,
          folder: `dc-${folderName}`,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        };
        this.opts.onRegisterGroup(groupLookupJid, group);
        logger.info(
          { chatJid: groupLookupJid, chatName, folder: group.folder },
          'Auto-registered Discord channel',
        );
      } else if (!group) {
        logger.debug(
          { chatJid: groupLookupJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err: Error) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient: Client<true>) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      await this.sendToChannel(textChannel, text);
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendMessageToThread(
    jid: string,
    text: string,
    triggerMessageId: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // If the channel is already a thread, just send there directly
      if (textChannel.isThread()) {
        await this.sendToChannel(textChannel, text);
        logger.info(
          { jid, length: text.length },
          'Discord message sent to existing thread',
        );
        return;
      }

      // Check thread cache for existing thread
      const cacheKey = `${channelId}:${triggerMessageId}`;
      const cachedThreadId = this.threadCache.get(cacheKey);

      if (cachedThreadId) {
        // Send to cached thread
        const threadChannel = await this.client.channels.fetch(cachedThreadId);
        if (threadChannel && 'send' in threadChannel) {
          await this.sendToChannel(threadChannel as TextChannel, text);
          logger.info(
            { jid, threadId: cachedThreadId, length: text.length },
            'Discord message sent to cached thread',
          );
          return;
        }
        // Cached thread no longer accessible — remove from cache and fall through
        this.threadCache.delete(cacheKey);
      }

      // Create a new thread from the trigger message
      const threadName =
        text.slice(0, 90).replace(/\n/g, ' ').trim() || 'Response';
      const thread = await textChannel.threads.create({
        startMessage: triggerMessageId,
        name: threadName,
      });

      // Cache the thread ID
      this.threadCache.set(cacheKey, thread.id);

      // Notify orchestrator so the new thread is recognized as a thread
      this.opts.onThreadMapping?.(`dc:${thread.id}`, jid);

      // Send the response into the thread
      await this.sendToChannel(thread as unknown as TextChannel, text);
      logger.info(
        { jid, threadId: thread.id, length: text.length },
        'Discord message sent to new thread',
      );
    } catch (err) {
      logger.warn(
        { jid, triggerMessageId, err },
        'Failed to create/send to thread, falling back to plain message',
      );
      await this.sendMessage(jid, text);
    }
  }

  /** Send text to a channel, splitting at 2000 chars if needed. */
  private async sendToChannel(
    channel: TextChannel,
    text: string,
  ): Promise<void> {
    const MAX_LENGTH = 2000;
    if (text.length <= MAX_LENGTH) {
      await channel.send(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await channel.send(text.slice(i, i + MAX_LENGTH));
      }
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}
