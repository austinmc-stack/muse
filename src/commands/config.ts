import {SlashCommandBuilder} from '@discordjs/builders';
import {ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits} from 'discord.js';
import {injectable} from 'inversify';
import {prisma} from '../utils/db.js';
import Command from './index.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('config')
    .setDescription('configure bot settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(subcommand => subcommand
      .setName('set-playlist-limit')
      .setDescription('set the maximum number of tracks that can be added from a playlist')
      .addIntegerOption(option => option
        .setName('limit')
        .setDescription('maximum number of tracks')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-wait-after-queue-empties')
      .setDescription('set the time to wait before leaving the voice channel when queue empties')
      .addIntegerOption(option => option
        .setName('delay')
        .setDescription('delay in seconds (set to 0 to never leave)')
        .setRequired(true)
        .setMinValue(0)))
    .addSubcommand(subcommand => subcommand
      .setName('set-leave-if-no-listeners')
      .setDescription('set whether to leave when all other participants leave')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to leave when everyone else leaves')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-queue-add-response-hidden')
      .setDescription('set whether bot responses to queue additions are only displayed to the requester')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether bot responses to queue additions are only displayed to the requester')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-reduce-vol-when-voice')
      .setDescription('set whether to turn down the volume when people speak')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to turn down the volume when people speak')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-reduce-vol-when-voice-target')
      .setDescription('set the target volume when people speak')
      .addIntegerOption(option => option
        .setName('volume')
        .setDescription('volume percentage (0 is muted, 100 is max & default)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-auto-announce-next-song')
      .setDescription('set whether to announce the next song in the queue automatically')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to announce the next song in the queue automatically')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-volume')
      .setDescription('set default volume used when entering the voice channel')
      .addIntegerOption(option => option
        .setName('level')
        .setDescription('volume percentage (0 is muted, 100 is max & default)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-queue-page-size')
      .setDescription('set the default page size of the /queue command')
      .addIntegerOption(option => option
        .setName('page-size')
        .setDescription('page size of the /queue command')
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-cleanup-mode')
      .setDescription('set which bot messages get auto-deleted')
      .addStringOption(option => option
        .setName('mode')
        .setDescription('none: never clean up, dj-only: clean up DJ commentary/announcements, all: clean up all bot messages')
        .setRequired(true)
        .addChoices(
          {name: 'none', value: 'NONE'},
          {name: 'dj-only', value: 'DJ_ONLY'},
          {name: 'all', value: 'ALL_BOT_MESSAGES'},
        )))
    .addSubcommand(subcommand => subcommand
      .setName('set-cleanup-delay')
      .setDescription('set how long a cleanup-eligible message stays before it\'s auto-deleted')
      .addIntegerOption(option => option
        .setName('seconds')
        .setDescription('delay in seconds')
        .setRequired(true)
        .setMinValue(1)))
    .addSubcommand(subcommand => subcommand
      .setName('set-cleanup-on-session-end')
      .setDescription('set whether tracked messages get swept up when the DJ session/queue ends')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to sweep tracked messages when the session ends')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-stats-digest-enabled')
      .setDescription('turn the scheduled stats digest on or off')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether the scheduled digest should run')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-stats-digest-cadence')
      .setDescription('set how often the scheduled stats digest sends, in days')
      .addIntegerOption(option => option
        .setName('days')
        .setDescription('cadence in days')
        .setMinValue(1)
        .setMaxValue(90)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-stats-webhook')
      .setDescription('set (or clear) the webhook URL the scheduled stats digest posts to')
      .addStringOption(option => option
        .setName('url')
        .setDescription('webhook URL, or "none" to clear it')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-stats-dm-owner')
      .setDescription('set whether the scheduled stats digest also DMs the server owner')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to DM the server owner')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('get')
      .setDescription('show all settings'));

  async execute(interaction: ChatInputCommandInteraction) {
    // Ensure guild settings exist before trying to update
    await getGuildSettings(interaction.guild!.id);

    switch (interaction.options.getSubcommand()) {
      case 'set-playlist-limit': {
        const limit: number = interaction.options.getInteger('limit')!;

        if (limit < 1) {
          throw new Error('invalid limit');
        }

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            playlistLimit: limit,
          },
        });

        await interaction.reply('👍 limit updated');

        break;
      }

      case 'set-wait-after-queue-empties': {
        const delay = interaction.options.getInteger('delay')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            secondsToWaitAfterQueueEmpties: delay,
          },
        });

        await interaction.reply('👍 wait delay updated');

        break;
      }

      case 'set-leave-if-no-listeners': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            leaveIfNoListeners: value,
          },
        });

        await interaction.reply('👍 leave setting updated');

        break;
      }

      case 'set-queue-add-response-hidden': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            queueAddResponseEphemeral: value,
          },
        });

        await interaction.reply('👍 queue add notification setting updated');

        break;
      }

      case 'set-auto-announce-next-song': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            autoAnnounceNextSong: value,
          },
        });

        await interaction.reply('👍 auto announce setting updated');

        break;
      }

      case 'set-default-volume': {
        const value = interaction.options.getInteger('level')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultVolume: value,
          },
        });

        await interaction.reply('👍 volume setting updated');

        break;
      }

      case 'set-default-queue-page-size': {
        const value = interaction.options.getInteger('page-size')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultQueuePageSize: value,
          },
        });

        await interaction.reply('👍 default queue page size updated');

        break;
      }

      case 'set-reduce-vol-when-voice': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            turnDownVolumeWhenPeopleSpeak: value,
          },
        });

        await interaction.reply('👍 turn down volume setting updated');

        break;
      }

      case 'set-reduce-vol-when-voice-target': {
        const value = interaction.options.getInteger('volume')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            turnDownVolumeWhenPeopleSpeakTarget: value,
          },
        });

        await interaction.reply('👍 turn down volume target setting updated');

        break;
      }

      case 'set-cleanup-mode': {
        const mode = interaction.options.getString('mode', true) as 'NONE' | 'DJ_ONLY' | 'ALL_BOT_MESSAGES';

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            cleanupMode: mode,
          },
        });

        await interaction.reply('👍 cleanup mode updated');

        break;
      }

      case 'set-cleanup-delay': {
        const value = interaction.options.getInteger('seconds')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            ephemeralDelaySeconds: value,
          },
        });

        await interaction.reply('👍 cleanup delay updated');

        break;
      }

      case 'set-cleanup-on-session-end': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            cleanupOnSessionEnd: value,
          },
        });

        await interaction.reply('👍 cleanup-on-session-end setting updated');

        break;
      }

      case 'set-stats-digest-enabled': {
        const value = interaction.options.getBoolean('value', true);

        await prisma.setting.update({
          where: {guildId: interaction.guild!.id},
          data: {statsDigestEnabled: value},
        });

        await interaction.reply('👍 scheduled stats digest setting updated');

        break;
      }

      case 'set-stats-digest-cadence': {
        const days = interaction.options.getInteger('days', true);

        await prisma.setting.update({
          where: {guildId: interaction.guild!.id},
          data: {statsDigestCadenceDays: days},
        });

        await interaction.reply('👍 stats digest cadence updated');

        break;
      }

      case 'set-stats-webhook': {
        const url = interaction.options.getString('url', true).trim();

        await prisma.setting.update({
          where: {guildId: interaction.guild!.id},
          data: {statsWebhookUrl: url.toLowerCase() === 'none' ? null : url},
        });

        await interaction.reply('👍 stats digest webhook updated');

        break;
      }

      case 'set-stats-dm-owner': {
        const value = interaction.options.getBoolean('value', true);

        await prisma.setting.update({
          where: {guildId: interaction.guild!.id},
          data: {statsDigestDmOwner: value},
        });

        await interaction.reply('👍 stats digest DM-owner setting updated');

        break;
      }

      case 'get': {
        const embed = new EmbedBuilder().setTitle('Config');

        const config = await getGuildSettings(interaction.guild!.id);

        const settingsToShow = {
          'Playlist Limit': config.playlistLimit,
          'Wait before leaving after queue empty': config.secondsToWaitAfterQueueEmpties === 0
            ? 'never leave'
            : `${config.secondsToWaitAfterQueueEmpties}s`,
          'Leave if there are no listeners': config.leaveIfNoListeners ? 'yes' : 'no',
          'Auto announce next song in queue': config.autoAnnounceNextSong ? 'yes' : 'no',
          'Add to queue reponses show for requester only': config.queueAddResponseEphemeral ? 'yes' : 'no',
          'Default Volume': config.defaultVolume,
          'Default queue page size': config.defaultQueuePageSize,
          'Reduce volume when people speak': config.turnDownVolumeWhenPeopleSpeak ? 'yes' : 'no',
          'Reduce volume when people speak target': config.turnDownVolumeWhenPeopleSpeakTarget,
          'Cleanup mode': config.cleanupMode,
          'Cleanup delay': `${config.ephemeralDelaySeconds}s`,
          'Cleanup on session end': config.cleanupOnSessionEnd ? 'yes' : 'no',
          'Scheduled stats digest': config.statsDigestEnabled ? 'yes' : 'no',
          'Stats digest cadence': `${config.statsDigestCadenceDays} day(s)`,
          'Stats digest webhook': config.statsWebhookUrl ?? 'not set',
          'Stats digest DMs server owner': config.statsDigestDmOwner ? 'yes' : 'no',
        };

        let description = '';
        for (const [key, value] of Object.entries(settingsToShow)) {
          description += `**${key}**: ${value}\n`;
        }

        embed.setDescription(description);

        await interaction.reply({embeds: [embed]});

        break;
      }

      default:
        throw new Error('unknown subcommand');
    }
  }
}
