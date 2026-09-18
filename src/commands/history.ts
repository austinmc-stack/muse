import {SlashCommandBuilder} from '@discordjs/builders';
import {ActionRowBuilder, ChatInputCommandInteraction, ComponentType, StringSelectMenuBuilder} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import {prisma} from '../utils/db.js';
import Command from './index.js';

// Discord's own select-menu cap.
const HISTORY_LIMIT = 25;

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('history')
    .setDescription('pick a recently played song to queue it back up');

  public requiresVC = true;

  public get isPlayerCommand() {
    return true;
  }

  constructor(@inject(TYPES.Services.AddQueryToQueue) private readonly addQueryToQueue: AddQueryToQueue) {}

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild!.id;

    const recent = await prisma.playHistory.findMany({
      where: {guildId, skipped: false},
      distinct: ['youtubeId'],
      orderBy: {playedAt: 'desc'},
      take: HISTORY_LIMIT,
    });

    if (recent.length === 0) {
      await interaction.reply({content: 'no play history yet for this server', ephemeral: true});
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('history-select')
      .setPlaceholder('pick a song to queue it back up')
      .addOptions(recent.map(track => ({
        label: track.title.slice(0, 100),
        description: track.artist.slice(0, 100),
        value: track.youtubeId,
      })));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const message = await interaction.reply({
      content: 'pick a song from recent history:',
      // Discord.js@14.11's InteractionReplyOptions['components'] typing can't
      // structurally unify ActionRowBuilder instances; safe at runtime (same
      // pattern as add-query-to-queue.ts's voice-channel-full confirmation).
      components: [row as any],
      ephemeral: true,
      fetchReply: true,
    });

    let selection;
    try {
      selection = await message.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: i => i.user.id === interaction.user.id,
        time: 30_000,
      });
    } catch {
      await interaction.editReply({content: 'timed out waiting for a selection.', components: []});
      return;
    }

    const youtubeId = selection.values[0];
    const track = recent.find(t => t.youtubeId === youtubeId);

    await interaction.editReply({content: `picked **${track?.title ?? youtubeId}**.`, components: []});

    // `selection` is a fresh, not-yet-acknowledged interaction (independent of
    // `interaction`'s own reply above), so addToQueue can defer/reply on it
    // exactly like it does for a normal /play. It's structurally compatible
    // (same guild/member/channel/deferReply/editReply surface) even though
    // typed as ChatInputCommandInteraction.
    await this.addQueryToQueue.addToQueue({
      query: `https://www.youtube.com/watch?v=${youtubeId}`,
      addToFrontOfQueue: false,
      shuffleAdditions: false,
      shouldSplitChapters: false,
      skipCurrentTrack: false,
      interaction: selection as unknown as ChatInputCommandInteraction,
    });
  }
}
