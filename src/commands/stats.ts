import {SlashCommandBuilder} from '@discordjs/builders';
import {AttachmentBuilder, ChatInputCommandInteraction} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import WrappedService from '../services/wrapped-service.js';
import WrappedCardRenderer from '../services/wrapped-card-renderer.js';
import {buildStatsDigestEmbed} from '../utils/build-embed.js';
import Command from './index.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const SCOPE_TO_SINCE: Record<string, () => Date> = {
  week: () => new Date(Date.now() - (7 * ONE_DAY_MS)),
  month: () => new Date(Date.now() - (30 * ONE_DAY_MS)),
  alltime: () => new Date(0),
};

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('server and personal listening stats')
    .addSubcommand(subcommand => subcommand
      .setName('digest')
      .setDescription('show a listening digest for this server')
      .addIntegerOption(option => option
        .setName('days')
        .setDescription('how many days back to summarize (default 7)')
        .setMinValue(1)
        .setMaxValue(365)))
    .addSubcommand(subcommand => subcommand
      .setName('leaderboard')
      .setDescription('show top listeners/tracks/artists for this server')
      .addStringOption(option => option
        .setName('scope')
        .setDescription('time range (default week)')
        .addChoices(
          {name: 'week', value: 'week'},
          {name: 'month', value: 'month'},
          {name: 'alltime', value: 'alltime'},
        )))
    .addSubcommand(subcommand => subcommand
      .setName('wrapped')
      .setDescription('see your yearly listening wrapped')
      .addIntegerOption(option => option
        .setName('year')
        .setDescription('year to summarize (defaults to the current year)'))
      .addBooleanOption(option => option
        .setName('server-only')
        .setDescription('only count listening in this server')));

  constructor(
    @inject(TYPES.Services.WrappedService) private readonly wrappedService: WrappedService,
    @inject(TYPES.Services.WrappedCardRenderer) private readonly wrappedCardRenderer: WrappedCardRenderer,
  ) {}

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild!.id;

    switch (interaction.options.getSubcommand()) {
      case 'digest': {
        const days = interaction.options.getInteger('days') ?? 7;
        const since = new Date(Date.now() - (days * ONE_DAY_MS));
        const summary = await this.wrappedService.generateGuildDigest(guildId, since);
        await interaction.reply({embeds: [buildStatsDigestEmbed(summary, `past ${days} day(s)`)]});
        break;
      }

      case 'leaderboard': {
        const scope = interaction.options.getString('scope') ?? 'week';
        const since = SCOPE_TO_SINCE[scope]();
        const summary = await this.wrappedService.generateGuildDigest(guildId, since);
        await interaction.reply({embeds: [buildStatsDigestEmbed(summary, scope)]});
        break;
      }

      case 'wrapped': {
        await interaction.deferReply();

        const year = interaction.options.getInteger('year') ?? new Date().getFullYear();
        const serverOnly = interaction.options.getBoolean('server-only') ?? false;

        const summary = await this.wrappedService.generate(
          interaction.user.id,
          year,
          serverOnly ? guildId : undefined,
        );

        const cards = await this.wrappedCardRenderer.renderCards(summary);

        await interaction.editReply({
          files: cards.map((card, index) => new AttachmentBuilder(card, {name: `wrapped-${year}-${index + 1}.png`})),
        });
        break;
      }

      default:
        throw new Error('unknown subcommand');
    }
  }
}
