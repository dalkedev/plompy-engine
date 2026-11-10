import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
  Events,
  type Message,
} from "discord.js";
import { redact, type Config, type Incoming } from "./config.js";
import type { Transport } from "./engine.js";
export function splitMessage(text: string, max = 1800): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length) {
    let end = Math.min(max, rest.length);
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    if (end < rest.length) {
      const newline = rest.lastIndexOf("\n", end);
      if (newline > max / 2) end = newline + 1;
    }
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return chunks.length ? chunks : ["Completed."];
}
export class DiscordTransport implements Transport {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
    rest: { retries: 0, timeout: 15000 },
  });
  constructor(private config: Config) {}
  async validate(): Promise<void> {
    if (this.client.user?.id !== this.config.botId)
      throw new Error("Wrong bot identity");
    // login() can resolve while the Gateway cache still contains an unavailable
    // guild. Authorization and role checks require fresh REST data, not that cache.
    const guild = await this.client.guilds.fetch({
      guild: this.config.guildId,
      force: true,
    });
    if (guild.ownerId !== this.config.ownerId)
      throw new Error("Guild owner mismatch");
    const parent = await this.client.channels.fetch(this.config.parentId, {
      force: true,
    });
    if (
      !parent ||
      parent.type !== ChannelType.GuildForum ||
      parent.guildId !== this.config.guildId
    )
      throw new Error("Private forum is required");
    if (
      parent
        .permissionsFor(guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new Error("Forum is public");
    for (const overwrite of parent.permissionOverwrites.cache.values()) {
      if (
        overwrite.allow.has(PermissionFlagsBits.ViewChannel) &&
        ![this.config.ownerId, this.config.botId].includes(overwrite.id)
      )
        throw new Error("Forum has additional explicit readers");
    }
  }
  async thread(id: string) {
    const channel = await this.client.channels.fetch(id, { force: true });
    if (
      !channel ||
      !channel.isThread() ||
      channel.guildId !== this.config.guildId ||
      channel.parentId !== this.config.parentId
    )
      throw new Error("Wrong reply thread");
    return channel;
  }
  async send(threadId: string, text: string): Promise<void> {
    await this.validate();
    const channel = await this.thread(threadId),
      safe = redact(text, this.config.token);
    const chunks = splitMessage(safe);
    if (chunks.length > 6) {
      await channel.send({
        content: chunks[0] + "\n\nFull response attached.",
        allowedMentions: { parse: [], repliedUser: false },
        files: [
          new AttachmentBuilder(Buffer.from(safe, "utf8"), {
            name: "szpont-answer.md",
          }),
        ],
      });
      return;
    }
    for (const content of chunks)
      await channel.send({
        content,
        allowedMentions: { parse: [], repliedUser: false },
      });
  }
  async typing(threadId: string): Promise<void> {
    const channel = await this.thread(threadId);
    await channel.sendTyping();
  }
  onMessage(handler: (message: Incoming) => Promise<unknown>): void {
    this.client.on(Events.MessageCreate, (message: Message) => {
      const channel = message.channel;
      const incoming: Incoming = {
        id: message.id,
        guildId: message.guildId,
        authorId: message.author.id,
        bot: message.author.bot,
        webhook: !!message.webhookId,
        channelId: message.channelId,
        parentId: channel.isThread() ? channel.parentId : null,
        thread: channel.isThread(),
        content: message.content,
        attachments: message.attachments.size,
        images: [...message.attachments.values()].map((attachment) => ({
          id: attachment.id,
          url: attachment.url,
          contentType: attachment.contentType,
          size: attachment.size,
        })),
      };
      void handler(incoming).catch(() => {
        console.log(
          JSON.stringify({ event: "message_handling", status: "failed" }),
        );
      });
    });
    // Do not expose gateway/REST errors or their request headers/bodies.
    this.client.on(Events.Error, () =>
      console.log(
        JSON.stringify({ event: "discord", status: "connection_error" }),
      ),
    );
    this.client.on(Events.ShardError, () =>
      console.log(
        JSON.stringify({ event: "discord", status: "gateway_error" }),
      ),
    );
  }
  async connect(): Promise<void> {
    await this.client.login(this.config.token);
    await this.validate();
  }
  close(): void {
    this.client.destroy();
  }
}
