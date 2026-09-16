import {SlashCommandBuilder} from '@discordjs/builders';
import {AttachmentBuilder, ChatInputCommandInteraction} from 'discord.js';
import {inject, injectable} from 'inversify';
import Command from './index.js';
import {TYPES} from '../types.js';
import WrappedService from '../services/wrapped-service.js';
import WrappedCardRenderer from '../services/wrapped-card-renderer.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('wrapped')
    .setDescription('see your yearly listening wrapped')
    .addIntegerOption(option => option
      .setName('year')
      .setDescription('year to summarize (defaults to the current year)'))
    .addBooleanOption(option => option
      .setName('server-only')
      .setDescription('only count listening in this server'));

  constructor(
    @inject(TYPES.Services.WrappedService) private readonly wrappedService: WrappedService,
    @inject(TYPES.Services.WrappedCardRenderer) private readonly wrappedCardRenderer: WrappedCardRenderer,
  ) {}

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const year = interaction.options.getInteger('year') ?? new Date().getFullYear();
    const serverOnly = interaction.options.getBoolean('server-only') ?? false;

    const summary = await this.wrappedService.generate(
      interaction.user.id,
      year,
      serverOnly ? interaction.guild?.id : undefined,
    );

    const cards = await this.wrappedCardRenderer.renderCards(summary);

    await interaction.editReply({
      files: cards.map((card, index) => new AttachmentBuilder(card, {name: `wrapped-${year}-${index + 1}.png`})),
    });
  }
}
