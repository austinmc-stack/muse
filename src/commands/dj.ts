import {SlashCommandBuilder} from '@discordjs/builders';
import {ChatInputCommandInteraction} from 'discord.js';
import {injectable} from 'inversify';
import Command from './index.js';
import {getDjSettings, updateDjSettings} from '../utils/get-dj-settings.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('dj')
    .setDescription('configure the auto-DJ')
    .addSubcommand(sub => sub.setName('enable').setDescription('turn on auto-queue + commentary'))
    .addSubcommand(sub => sub.setName('disable').setDescription('turn off the auto-DJ'))
    .addSubcommand(sub =>
      sub
        .setName('persona')
        .setDescription('set the DJ\'s personality')
        .addStringOption(opt =>
          opt
            .setName('style')
            .setDescription('personality style')
            .setRequired(true)
            .addChoices(
              {name: 'Hype', value: 'hype'},
              {name: 'Chill', value: 'chill'},
              {name: 'Sarcastic', value: 'sarcastic'},
            ),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('commentary')
        .setDescription('set how often the DJ talks')
        .addIntegerOption(opt =>
          opt
            .setName('frequency')
            .setDescription('talk every N tracks (1 = every track)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand(sub => sub.setName('status').setDescription('show current DJ settings'));

  public requiresVC = false;

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild?.id;
    if (!guildId) {
      await interaction.reply({content: 'this only works in a server', ephemeral: true});
      return;
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'enable': {
        await updateDjSettings(guildId, {enabled: true});
        await interaction.reply('🎧 auto-DJ is now **on**. I\'ll keep the queue full and chime in between songs.');
        break;
      }

      case 'disable': {
        await updateDjSettings(guildId, {enabled: false});
        await interaction.reply('auto-DJ is now **off**.');
        break;
      }

      case 'persona': {
        const style = interaction.options.getString('style', true);
        await updateDjSettings(guildId, {persona: style});
        await interaction.reply(`got it — DJ persona set to **${style}**.`);
        break;
      }

      case 'commentary': {
        const freq = interaction.options.getInteger('frequency', true);
        await updateDjSettings(guildId, {commentaryFrequency: freq});
        await interaction.reply(`I'll talk every **${freq}** track(s) now.`);
        break;
      }

      case 'status': {
        const settings = await getDjSettings(guildId);
        await interaction.reply([
          `**Auto-DJ:** ${settings.enabled ? 'On ✅' : 'Off ❌'}`,
          `**Commentary:** ${settings.commentaryEnabled ? 'On' : 'Off'} (every ${settings.commentaryFrequency} track(s))`,
          `**Persona:** ${settings.persona}`,
          `**Min queue size before auto-fill:** ${settings.minQueueSize}`,
        ].join('\n'));
        break;
      }

      default: {
        throw new Error('unknown subcommand');
      }
    }
  }
}
