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
    .addSubcommand(sub => sub.setName('enable').setDescription('turn on auto-queue'))
    .addSubcommand(sub => sub.setName('disable').setDescription('turn off the auto-DJ'))
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
        await interaction.reply('🎧 auto-DJ is now **on**. I\'ll keep the queue full and post in chat when I add songs.');
        break;
      }

      case 'disable': {
        await updateDjSettings(guildId, {enabled: false});
        await interaction.reply('auto-DJ is now **off**.');
        break;
      }

      case 'status': {
        const settings = await getDjSettings(guildId);
        await interaction.reply([
          `**Auto-DJ:** ${settings.enabled ? 'On ✅' : 'Off ❌'}`,
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
