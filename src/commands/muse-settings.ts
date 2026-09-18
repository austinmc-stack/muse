import {SlashCommandBuilder} from '@discordjs/builders';
import {
  ActionRowBuilder,
  AnyComponentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  MessageComponentInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {injectable} from 'inversify';
import {Setting, DjSetting} from '@prisma/client';
import {prisma} from '../utils/db.js';
import Command from './index.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {getDjSettings, updateDjSettings} from '../utils/get-dj-settings.js';

// A guild owner who walks away from the menu shouldn't leave it clickable
// forever -- 5 minutes of inactivity closes it (matches history.ts's shorter
// 30s single-shot timeout, scaled up since this is a multi-step wizard).
const SESSION_TIMEOUT_MS = 5 * 60_000;

type CategoryId = 'cleanup' | 'dj' | 'stats';

// All customIds this command's components can produce. Kept as an exact set
// of literal strings (no per-guild/per-user data embedded) so routing is a
// plain switch/prefix check -- no central dispatcher needed, same
// self-contained-collector pattern history.ts already uses.
const IDS = {
  category: 'muse-settings:category',
  back: 'muse-settings:back',
  cleanupMode: 'muse-settings:cleanup:mode',
  cleanupDelay: 'muse-settings:cleanup:delay',
  cleanupSessionEnd: 'muse-settings:cleanup:session-end',
  djEnabled: 'muse-settings:dj:enabled',
  djMinQueueSize: 'muse-settings:dj:min-queue-size',
  djChannel: 'muse-settings:dj:channel',
  djClearChannel: 'muse-settings:dj:clear-channel',
  statsEnabled: 'muse-settings:stats:enabled',
  statsCadence: 'muse-settings:stats:cadence',
  statsDmOwner: 'muse-settings:stats:dm-owner',
} as const;

export interface Screen {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder[];
}

// --- plain-language formatting (pure, unit-testable) ---

export const formatYesNo = (value: boolean): string => (value ? 'On' : 'Off');

export const formatCleanupMode = (mode: string): string => {
  switch (mode) {
    case 'NONE': return 'None (never clean up)';
    case 'DJ_ONLY': return 'DJ messages only';
    case 'ALL_BOT_MESSAGES': return 'All bot messages';
    default: return mode;
  }
};

export const formatDjChannel = (channelId: string | null): string =>
  (channelId ? `<#${channelId}>` : 'follows the active voice channel');

// --- small component builders shared across categories ---

const backButton = (): ButtonBuilder => new ButtonBuilder()
  .setCustomId(IDS.back)
  .setLabel('◀ Categories')
  .setStyle(ButtonStyle.Secondary);

const yesNoSelect = (customId: string, current: boolean, label: string): StringSelectMenuBuilder =>
  new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(`${label} (now: ${formatYesNo(current)})`)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('On').setValue('true').setDefault(current),
      new StringSelectMenuOptionBuilder().setLabel('Off').setValue('false').setDefault(!current),
    );

interface PresetIntSelectOptions {
  customId: string;
  presets: number[];
  current: number;
  unit: string;
  label: string;
}

const presetIntSelect = (options: PresetIntSelectOptions): StringSelectMenuBuilder =>
  new StringSelectMenuBuilder()
    .setCustomId(options.customId)
    .setPlaceholder(`${options.label} (now: ${options.current}${options.unit})`)
    .addOptions(options.presets.map(value => new StringSelectMenuOptionBuilder()
      .setLabel(`${value}${options.unit}`)
      .setValue(String(value))
      .setDefault(value === options.current)));

const row = (component: AnyComponentBuilder): ActionRowBuilder =>
  new ActionRowBuilder().addComponents(component);

// --- screens (pure: take already-fetched settings, return embed + components) ---

export function buildTopScreen(): Screen {
  const embed = new EmbedBuilder()
    .setTitle('🎛️ Muse Settings')
    .setDescription('Pick a category to configure. Only you can see this.')
    .setColor(Colors.Blurple);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDS.category)
    .setPlaceholder('Choose a category…')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Cleanup').setValue('cleanup').setEmoji('🧹')
        .setDescription('auto-delete DJ/bot messages'),
      new StringSelectMenuOptionBuilder().setLabel('DJ').setValue('dj').setEmoji('🎧')
        .setDescription('auto-queue + DJ message channel'),
      new StringSelectMenuOptionBuilder().setLabel('Stats Digest').setValue('stats').setEmoji('📊')
        .setDescription('scheduled listening recap'),
    );

  return {embeds: [embed], components: [row(menu)]};
}

const withConfirmation = (headline: string, confirmation?: string): string =>
  (confirmation ? `✅ ${confirmation}\n\n${headline}` : headline);

const CLEANUP_DELAY_PRESETS = [15, 30, 45, 60, 120, 300];

export function buildCleanupScreen(setting: Pick<Setting, 'cleanupMode' | 'ephemeralDelaySeconds' | 'cleanupOnSessionEnd'>, confirmation?: string): Screen {
  const headline = [
    `**Mode:** ${formatCleanupMode(setting.cleanupMode)}`,
    `**Auto-delete delay:** ${setting.ephemeralDelaySeconds}s`,
    `**Sweep on session end:** ${formatYesNo(setting.cleanupOnSessionEnd)}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🧹 Cleanup')
    .setDescription(withConfirmation(headline, confirmation))
    .setColor(setting.cleanupMode === 'NONE' ? Colors.Grey : Colors.Green)
    .setFooter({text: 'Controls which bot messages get auto-deleted, and when.'});

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId(IDS.cleanupMode)
    .setPlaceholder('Cleanup mode')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('None — never clean up').setValue('NONE').setDefault(setting.cleanupMode === 'NONE'),
      new StringSelectMenuOptionBuilder().setLabel('DJ only — clean up DJ commentary/announcements').setValue('DJ_ONLY').setDefault(setting.cleanupMode === 'DJ_ONLY'),
      new StringSelectMenuOptionBuilder().setLabel('All — clean up all bot messages').setValue('ALL_BOT_MESSAGES').setDefault(setting.cleanupMode === 'ALL_BOT_MESSAGES'),
    );

  const delaySelect = presetIntSelect({customId: IDS.cleanupDelay, presets: CLEANUP_DELAY_PRESETS, current: setting.ephemeralDelaySeconds, unit: 's', label: 'Auto-delete delay'});
  const sessionEndSelect = yesNoSelect(IDS.cleanupSessionEnd, setting.cleanupOnSessionEnd, 'Sweep on session end');

  return {
    embeds: [embed],
    components: [row(modeSelect), row(delaySelect), row(sessionEndSelect), row(backButton())],
  };
}

const DJ_MIN_QUEUE_PRESETS = [1, 2, 3, 5, 10];

export function buildDjScreen(setting: Pick<Setting, 'djChannelId'>, dj: Pick<DjSetting, 'enabled' | 'minQueueSize'>, confirmation?: string): Screen {
  const headline = [
    `**Auto-DJ:** ${formatYesNo(dj.enabled)}`,
    `**Message channel:** ${formatDjChannel(setting.djChannelId)}`,
    `**Min queue size before auto-fill:** ${dj.minQueueSize}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🎧 DJ')
    .setDescription(withConfirmation(headline, confirmation))
    .setColor(dj.enabled ? Colors.Green : Colors.Grey)
    .setFooter({text: 'Auto-DJ keeps the queue full; the message channel pins DJ chat to one place.'});

  const enabledSelect = yesNoSelect(IDS.djEnabled, dj.enabled, 'Auto-DJ');

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(IDS.djChannel)
    .setPlaceholder(`DJ message channel (now: ${setting.djChannelId ? '#channel' : 'follows voice channel'})`)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice);
  if (setting.djChannelId) {
    channelSelect.setDefaultChannels(setting.djChannelId);
  }

  const minQueueSelect = presetIntSelect({customId: IDS.djMinQueueSize, presets: DJ_MIN_QUEUE_PRESETS, current: dj.minQueueSize, unit: '', label: 'Min queue size before auto-fill'});

  const actionsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.djClearChannel).setLabel('Follow active voice channel').setStyle(ButtonStyle.Secondary),
    backButton(),
  );

  return {
    embeds: [embed],
    components: [row(enabledSelect), row(channelSelect), row(minQueueSelect), actionsRow],
  };
}

const STATS_CADENCE_PRESETS = [1, 3, 7, 14, 30];

export function buildStatsScreen(setting: Pick<Setting, 'statsDigestEnabled' | 'statsDigestCadenceDays' | 'statsDigestDmOwner' | 'statsWebhookUrl'>, confirmation?: string): Screen {
  const headline = [
    `**Digest:** ${formatYesNo(setting.statsDigestEnabled)}`,
    `**Cadence:** every ${setting.statsDigestCadenceDays} day(s)`,
    `**DM server owner:** ${formatYesNo(setting.statsDigestDmOwner)}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📊 Stats Digest')
    .setDescription(withConfirmation(headline, confirmation))
    .setColor(setting.statsDigestEnabled ? Colors.Green : Colors.Grey)
    .setFooter({text: setting.statsWebhookUrl
      ? 'Webhook is set. Change it with /config set-stats-webhook (free text, not menu-friendly).'
      : 'No webhook set. Set one with /config set-stats-webhook if you want digests posted there too.'});

  const enabledSelect = yesNoSelect(IDS.statsEnabled, setting.statsDigestEnabled, 'Digest');
  const cadenceSelect = presetIntSelect({customId: IDS.statsCadence, presets: STATS_CADENCE_PRESETS, current: setting.statsDigestCadenceDays, unit: 'd', label: 'Cadence'});
  const dmOwnerSelect = yesNoSelect(IDS.statsDmOwner, setting.statsDigestDmOwner, 'DM server owner');

  return {
    embeds: [embed],
    components: [row(enabledSelect), row(cadenceSelect), row(dmOwnerSelect), row(backButton())],
  };
}

// Which category a field customId belongs to, so a value change knows which
// screen to re-render with its confirmation banner.
export const categoryForCustomId = (customId: string): CategoryId => {
  if (customId.startsWith('muse-settings:cleanup:')) {
    return 'cleanup';
  }

  if (customId.startsWith('muse-settings:dj:')) {
    return 'dj';
  }

  return 'stats';
};

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('muse-settings')
    .setDescription('guided settings menu: cleanup, DJ, and stats digest')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild!.id;

    // Ensure guild settings exist before trying to read/update (matches /config).
    await getGuildSettings(guildId);

    const top = buildTopScreen();
    const message = await interaction.reply({
      embeds: top.embeds,
      // Discord.js@14.11's InteractionReplyOptions['components'] typing can't
      // structurally unify ActionRowBuilder instances; safe at runtime (same
      // pattern as add-query-to-queue.ts's voice-channel-full confirmation
      // and history.ts's select menu).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      components: top.components as any,
      ephemeral: true,
      fetchReply: true,
    });

    // This is an interactive wizard: each iteration must wait for the
    // previous step's click before it knows what to render next, so the
    // awaits below can't be parallelized.
    for (;;) {
      let component: MessageComponentInteraction;
      try {
        // Omitting componentType collects both buttons and select menus on
        // this message; the return type can't be inferred without it, hence
        // the cast (same class of discord.js@14.11 typing friction as above).
        // eslint-disable-next-line no-await-in-loop
        component = await message.awaitMessageComponent({
          filter: i => i.user.id === interaction.user.id,
          time: SESSION_TIMEOUT_MS,
        }) as unknown as MessageComponentInteraction;
      } catch {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      const screen = await this.handleComponent(component, guildId);
      // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment
      await component.update({embeds: screen.embeds, components: screen.components as any});
    }

    await interaction.editReply({components: []}).catch(() => undefined);
  }

  private async handleComponent(component: MessageComponentInteraction, guildId: string): Promise<Screen> {
    if (component.customId === IDS.back) {
      return buildTopScreen();
    }

    if (component.customId === IDS.category && component.isStringSelectMenu()) {
      return this.renderCategory(component.values[0] as CategoryId, guildId);
    }

    const value = component.isStringSelectMenu() || component.isChannelSelectMenu()
      ? component.values[0]
      : ''; // The DJ "clear channel" button carries no value

    const confirmation = await this.applyChange(component.customId, value, guildId);
    return this.renderCategory(categoryForCustomId(component.customId), guildId, confirmation);
  }

  private async renderCategory(category: CategoryId, guildId: string, confirmation?: string): Promise<Screen> {
    const setting = await getGuildSettings(guildId);

    switch (category) {
      case 'cleanup': {
        return buildCleanupScreen(setting, confirmation);
      }

      case 'dj': {
        const dj = await getDjSettings(guildId);
        return buildDjScreen(setting, dj, confirmation);
      }

      case 'stats': {
        return buildStatsScreen(setting, confirmation);
      }

      default: {
        throw new Error(`unknown settings category: ${category as string}`);
      }
    }
  }

  private async applyChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
      case IDS.cleanupMode: {
        const mode = value as 'NONE' | 'DJ_ONLY' | 'ALL_BOT_MESSAGES';
        await prisma.setting.update({where: {guildId}, data: {cleanupMode: mode}});
        return `Cleanup mode is now **${formatCleanupMode(mode)}**.`;
      }

      case IDS.cleanupDelay: {
        const seconds = Number(value);
        await prisma.setting.update({where: {guildId}, data: {ephemeralDelaySeconds: seconds}});
        return `Cleanup delay is now **${seconds}s**.`;
      }

      case IDS.cleanupSessionEnd: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {cleanupOnSessionEnd: enabled}});
        return `Cleanup on session end is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.djEnabled: {
        const enabled = value === 'true';
        await updateDjSettings(guildId, {enabled});
        return `Auto-DJ is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.djMinQueueSize: {
        const size = Number(value);
        await updateDjSettings(guildId, {minQueueSize: size});
        return `Auto-DJ will fill the queue once it drops below **${size}** song(s).`;
      }

      case IDS.djChannel: {
        await prisma.setting.update({where: {guildId}, data: {djChannelId: value}});
        return `DJ messages will now be sent to <#${value}>.`;
      }

      case IDS.djClearChannel: {
        await prisma.setting.update({where: {guildId}, data: {djChannelId: null}});
        return 'DJ messages will follow the active voice channel again.';
      }

      case IDS.statsEnabled: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {statsDigestEnabled: enabled}});
        return `Scheduled stats digest is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.statsCadence: {
        const days = Number(value);
        await prisma.setting.update({where: {guildId}, data: {statsDigestCadenceDays: days}});
        return `Stats digest will now send every **${days} day(s)**.`;
      }

      case IDS.statsDmOwner: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {statsDigestDmOwner: enabled}});
        return `Stats digest **${enabled ? 'will' : 'will not'}** DM the server owner.`;
      }

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }
}
