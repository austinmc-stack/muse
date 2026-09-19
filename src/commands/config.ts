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
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
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
// The webhook modal gets its own much shorter budget: while awaitModalSubmit
// is pending, the outer loop's component collector isn't attached, so a
// dismissed modal (e.g. Escape) leaves the wizard message stale and every
// click on it fails until this await resolves. Discord fires no event on
// dismissal, so we can't recover early -- keeping this short instead of
// reusing SESSION_TIMEOUT_MS bounds that dead window to under a minute.
export const MODAL_TIMEOUT_MS = 45_000;

type CategoryId = 'cleanup' | 'dj' | 'stats' | 'playback' | 'voice' | 'ambience' | 'view-all';

// All customIds this command's components can produce. Kept as an exact set
// of literal strings (no per-guild/per-user data embedded) so routing is a
// plain switch/prefix check -- no central dispatcher needed, same
// self-contained-collector pattern history.ts already uses.
const IDS = {
  category: 'config:category',
  back: 'config:back',
  cleanupMode: 'config:cleanup:mode',
  cleanupDelay: 'config:cleanup:delay',
  cleanupSessionEnd: 'config:cleanup:session-end',
  djEnabled: 'config:dj:enabled',
  djMinQueueSize: 'config:dj:min-queue-size',
  djChannel: 'config:dj:channel',
  djClearChannel: 'config:dj:clear-channel',
  statsEnabled: 'config:stats:enabled',
  statsCadence: 'config:stats:cadence',
  statsDmOwner: 'config:stats:dm-owner',
  statsWebhookEdit: 'config:stats:webhook-edit',
  statsWebhookModal: 'config:stats:webhook-modal',
  statsWebhookInput: 'config:stats:webhook-input',
  playbackDefaultVolume: 'config:playback:default-volume',
  playbackQueuePageSize: 'config:playback:queue-page-size',
  playbackPlaylistLimit: 'config:playback:playlist-limit',
  playbackQueueAddEphemeral: 'config:playback:queue-add-ephemeral',
  voiceLeaveIfNoListeners: 'config:voice:leave-if-no-listeners',
  voiceWaitAfterEmpty: 'config:voice:wait-after-empty',
  voiceAutoAnnounce: 'config:voice:auto-announce',
  ambienceDuckEnabled: 'config:ambience:duck-enabled',
  ambienceDuckTarget: 'config:ambience:duck-target',
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

// SecondsToWaitAfterQueueEmpties === 0 has a special meaning ("never leave"),
// same as the old set-wait-after-queue-empties subcommand's description.
export const formatWaitAfterEmpty = (seconds: number): string =>
  (seconds === 0 ? 'never (stays until manually stopped)' : `${seconds}s`);

// A webhook URL is credential-equivalent -- anyone holding it can post as
// the bot. buildStatsScreen already keeps it to "set"/"not set"; this view
// is meant to show a bit more (so an admin can recognize which webhook is
// configured) without leaking a screenshot-usable credential, so show the
// host plus a few trailing characters instead of the full URL.
export const formatWebhookUrl = (url: string | null): string => {
  if (!url) {
    return 'not set';
  }

  try {
    const {host} = new URL(url);
    return `${host}/…${url.slice(-4)}`;
  } catch {
    return 'set (unparseable URL)';
  }
};

// The old /config set-stats-webhook subcommand did NOT actually validate the
// string was a URL -- see git show 9762b2f -- it only trimmed it and treated
// the literal word "none" as a clear instruction. The brief asks for real
// URL validation here, which is a deliberate improvement over the old
// behavior, not a preserved behavior. Clearing now happens by submitting the
// modal with the field left blank (more natural for a modal than typing the
// word "none"), rather than being preserved from the old subcommand.
export type WebhookValidation =
  | {ok: true; url: string | null}
  | {ok: false; error: string};

export const validateWebhookUrl = (raw: string): WebhookValidation => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {ok: true, url: null};
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {ok: false, error: 'That doesn\'t look like a valid URL — check for typos and try again.'};
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {ok: false, error: 'Webhook URL must start with http:// or https://.'};
  }

  return {ok: true, url: trimmed};
};

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

// Discord hard-caps a message at 5 action rows total, and a select menu
// always takes a whole row to itself (only buttons can share one). That's
// why the categories below are split the way they are instead of one big
// "Playback" bucket -- e.g. Playback already uses 4 selects + the back-row,
// which is the most a single screen can hold and still have room to
// navigate back out.
export function buildTopScreen(): Screen {
  const embed = new EmbedBuilder()
    .setTitle('🎛️ Muse Settings')
    .setDescription('Pick a category to configure, or view everything at once. Only you can see this.')
    .setColor(Colors.Blurple);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDS.category)
    .setPlaceholder('Choose a category…')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Playback').setValue('playback').setEmoji('▶️')
        .setDescription('volume, queue page size, playlist limit'),
      new StringSelectMenuOptionBuilder().setLabel('Voice Presence').setValue('voice').setEmoji('🚪')
        .setDescription('auto-leave timing + song announcements'),
      new StringSelectMenuOptionBuilder().setLabel('Ambience').setValue('ambience').setEmoji('🔉')
        .setDescription('duck volume when people talk'),
      new StringSelectMenuOptionBuilder().setLabel('Cleanup').setValue('cleanup').setEmoji('🧹')
        .setDescription('auto-delete DJ/bot messages'),
      new StringSelectMenuOptionBuilder().setLabel('DJ').setValue('dj').setEmoji('🎧')
        .setDescription('auto-queue + DJ message channel'),
      new StringSelectMenuOptionBuilder().setLabel('Stats Digest').setValue('stats').setEmoji('📊')
        .setDescription('scheduled listening recap + webhook'),
      new StringSelectMenuOptionBuilder().setLabel('View All Settings').setValue('view-all').setEmoji('📋')
        .setDescription('see every current value at a glance'),
    );

  return {embeds: [embed], components: [row(menu)]};
}

const withConfirmation = (headline: string, confirmation?: string, icon = '✅'): string =>
  (confirmation ? `${icon} ${confirmation}\n\n${headline}` : headline);

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
    `**Keep this many songs queued:** ${dj.minQueueSize}`,
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

  const minQueueSelect = presetIntSelect({customId: IDS.djMinQueueSize, presets: DJ_MIN_QUEUE_PRESETS, current: dj.minQueueSize, unit: '', label: 'Keep this many songs queued'});

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

export function buildStatsScreen(setting: Pick<Setting, 'statsDigestEnabled' | 'statsDigestCadenceDays' | 'statsDigestDmOwner' | 'statsWebhookUrl'>, confirmation?: string, icon?: string): Screen {
  const headline = [
    `**Digest:** ${formatYesNo(setting.statsDigestEnabled)}`,
    `**Cadence:** every ${setting.statsDigestCadenceDays} day(s)`,
    `**DM server owner:** ${formatYesNo(setting.statsDigestDmOwner)}`,
    `**Webhook:** ${setting.statsWebhookUrl ? 'set' : 'not set'}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📊 Stats Digest')
    .setDescription(withConfirmation(headline, confirmation, icon))
    .setColor(setting.statsDigestEnabled ? Colors.Green : Colors.Grey)
    .setFooter({text: setting.statsWebhookUrl
      ? 'Webhook is set. Use the button below to change or clear it.'
      : 'No webhook set. Digests still send to Discord; use the button below to add one for cross-posting.'});

  const enabledSelect = yesNoSelect(IDS.statsEnabled, setting.statsDigestEnabled, 'Digest');
  const cadenceSelect = presetIntSelect({customId: IDS.statsCadence, presets: STATS_CADENCE_PRESETS, current: setting.statsDigestCadenceDays, unit: 'd', label: 'Cadence'});
  const dmOwnerSelect = yesNoSelect(IDS.statsDmOwner, setting.statsDigestDmOwner, 'DM server owner');

  const actionsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.statsWebhookEdit).setLabel(setting.statsWebhookUrl ? 'Edit webhook' : 'Set webhook').setStyle(ButtonStyle.Secondary),
    backButton(),
  );

  return {
    embeds: [embed],
    components: [row(enabledSelect), row(cadenceSelect), row(dmOwnerSelect), actionsRow],
  };
}

const DEFAULT_VOLUME_PRESETS = [0, 25, 50, 75, 100];
const QUEUE_PAGE_SIZE_PRESETS = [5, 10, 15, 20, 30];
const PLAYLIST_LIMIT_PRESETS = [10, 25, 50, 100, 200];

export function buildPlaybackScreen(setting: Pick<Setting, 'defaultVolume' | 'defaultQueuePageSize' | 'playlistLimit' | 'queueAddResponseEphemeral'>, confirmation?: string): Screen {
  const headline = [
    `**Default volume:** ${setting.defaultVolume}%`,
    `**Queue page size:** ${setting.defaultQueuePageSize}`,
    `**Playlist add limit:** ${setting.playlistLimit} tracks`,
    `**Queue-add responses:** ${setting.queueAddResponseEphemeral ? 'Private (only you see them)' : 'Public'}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('▶️ Playback')
    .setDescription(withConfirmation(headline, confirmation))
    .setColor(Colors.Blurple)
    .setFooter({text: 'Controls how tracks get added, queued, and played.'});

  const volumeSelect = presetIntSelect({customId: IDS.playbackDefaultVolume, presets: DEFAULT_VOLUME_PRESETS, current: setting.defaultVolume, unit: '%', label: 'Default volume'});
  const pageSizeSelect = presetIntSelect({customId: IDS.playbackQueuePageSize, presets: QUEUE_PAGE_SIZE_PRESETS, current: setting.defaultQueuePageSize, unit: '', label: 'Queue page size'});
  const playlistLimitSelect = presetIntSelect({customId: IDS.playbackPlaylistLimit, presets: PLAYLIST_LIMIT_PRESETS, current: setting.playlistLimit, unit: '', label: 'Playlist add limit'});
  const ephemeralSelect = yesNoSelect(IDS.playbackQueueAddEphemeral, setting.queueAddResponseEphemeral, 'Private queue-add responses');

  return {
    embeds: [embed],
    components: [row(volumeSelect), row(pageSizeSelect), row(playlistLimitSelect), row(ephemeralSelect), row(backButton())],
  };
}

const WAIT_AFTER_EMPTY_PRESETS = [0, 15, 30, 60, 120, 300];

export function buildVoiceScreen(setting: Pick<Setting, 'leaveIfNoListeners' | 'secondsToWaitAfterQueueEmpties' | 'autoAnnounceNextSong'>, confirmation?: string): Screen {
  const headline = [
    `**Leave when no listeners:** ${formatYesNo(setting.leaveIfNoListeners)}`,
    `**Wait after queue empties:** ${formatWaitAfterEmpty(setting.secondsToWaitAfterQueueEmpties)}`,
    `**Auto-announce next song:** ${formatYesNo(setting.autoAnnounceNextSong)}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🚪 Voice Presence')
    .setDescription(withConfirmation(headline, confirmation))
    .setColor(Colors.Blurple)
    .setFooter({text: 'When the bot leaves the voice channel, and what it announces while there.'});

  const leaveSelect = yesNoSelect(IDS.voiceLeaveIfNoListeners, setting.leaveIfNoListeners, 'Leave when no listeners');
  const waitSelect = presetIntSelect({customId: IDS.voiceWaitAfterEmpty, presets: WAIT_AFTER_EMPTY_PRESETS, current: setting.secondsToWaitAfterQueueEmpties, unit: 's', label: 'Wait after queue empties'});
  const announceSelect = yesNoSelect(IDS.voiceAutoAnnounce, setting.autoAnnounceNextSong, 'Auto-announce next song');

  return {
    embeds: [embed],
    components: [row(leaveSelect), row(waitSelect), row(announceSelect), row(backButton())],
  };
}

const DUCK_TARGET_PRESETS = [0, 10, 20, 30, 50];

// TurnDownVolumeWhenPeopleSpeakTarget only matters once ducking is turned
// on, so its select only shows up then -- keeps the screen short when it's
// off, and leaves headroom under Discord's 5-row cap either way.
export function buildAmbienceScreen(setting: Pick<Setting, 'turnDownVolumeWhenPeopleSpeak' | 'turnDownVolumeWhenPeopleSpeakTarget'>, confirmation?: string): Screen {
  const headlineLines = [`**Turn down volume when people speak:** ${formatYesNo(setting.turnDownVolumeWhenPeopleSpeak)}`];
  if (setting.turnDownVolumeWhenPeopleSpeak) {
    headlineLines.push(`**Target volume while speaking:** ${setting.turnDownVolumeWhenPeopleSpeakTarget}%`);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔉 Ambience')
    .setDescription(withConfirmation(headlineLines.join('\n'), confirmation))
    .setColor(setting.turnDownVolumeWhenPeopleSpeak ? Colors.Green : Colors.Grey)
    .setFooter({text: 'Ducks playback volume while people are talking in the voice channel.'});

  const components = [row(yesNoSelect(IDS.ambienceDuckEnabled, setting.turnDownVolumeWhenPeopleSpeak, 'Turn down volume when people speak'))];

  if (setting.turnDownVolumeWhenPeopleSpeak) {
    components.push(row(presetIntSelect({customId: IDS.ambienceDuckTarget, presets: DUCK_TARGET_PRESETS, current: setting.turnDownVolumeWhenPeopleSpeakTarget, unit: '%', label: 'Target volume while speaking'})));
  }

  components.push(row(backButton()));

  return {embeds: [embed], components};
}

// Read-only equivalent of the old /config get subcommand -- one screen with
// every current value, so a guild owner isn't forced to click through every
// category just to audit what's set.
type ViewAllSetting = Pick<Setting,
| 'cleanupMode' | 'ephemeralDelaySeconds' | 'cleanupOnSessionEnd'
| 'djChannelId'
| 'statsDigestEnabled' | 'statsDigestCadenceDays' | 'statsDigestDmOwner' | 'statsWebhookUrl'
| 'defaultVolume' | 'defaultQueuePageSize' | 'playlistLimit' | 'queueAddResponseEphemeral'
| 'leaveIfNoListeners' | 'secondsToWaitAfterQueueEmpties' | 'autoAnnounceNextSong'
| 'turnDownVolumeWhenPeopleSpeak' | 'turnDownVolumeWhenPeopleSpeakTarget'
>;

export function buildViewAllScreen(setting: ViewAllSetting, dj: Pick<DjSetting, 'enabled' | 'minQueueSize'>): Screen {
  const lines: Array<[string, string]> = [
    ['Cleanup mode', formatCleanupMode(setting.cleanupMode)],
    ['Cleanup delay', `${setting.ephemeralDelaySeconds}s`],
    ['Cleanup on session end', formatYesNo(setting.cleanupOnSessionEnd)],
    ['Auto-DJ', formatYesNo(dj.enabled)],
    ['DJ min queue size', String(dj.minQueueSize)],
    ['DJ message channel', formatDjChannel(setting.djChannelId)],
    ['Stats digest', formatYesNo(setting.statsDigestEnabled)],
    ['Stats digest cadence', `${setting.statsDigestCadenceDays} day(s)`],
    ['Stats digest DMs owner', formatYesNo(setting.statsDigestDmOwner)],
    ['Stats webhook', formatWebhookUrl(setting.statsWebhookUrl)],
    ['Default volume', `${setting.defaultVolume}%`],
    ['Queue page size', String(setting.defaultQueuePageSize)],
    ['Playlist add limit', `${setting.playlistLimit} tracks`],
    ['Queue-add responses', setting.queueAddResponseEphemeral ? 'Private' : 'Public'],
    ['Leave when no listeners', formatYesNo(setting.leaveIfNoListeners)],
    ['Wait after queue empties', formatWaitAfterEmpty(setting.secondsToWaitAfterQueueEmpties)],
    ['Auto-announce next song', formatYesNo(setting.autoAnnounceNextSong)],
    ['Turn down volume when people speak', formatYesNo(setting.turnDownVolumeWhenPeopleSpeak)],
    ['Target volume while speaking', `${setting.turnDownVolumeWhenPeopleSpeakTarget}%`],
  ];

  const embed = new EmbedBuilder()
    .setTitle('📋 All Settings')
    .setDescription(lines.map(([key, value]) => `**${key}:** ${value}`).join('\n'))
    .setColor(Colors.Blurple)
    .setFooter({text: 'Read-only. Pick a category from the menu to change something.'});

  return {embeds: [embed], components: [row(backButton())]};
}

const buildWebhookModal = (current: string | null): ModalBuilder => {
  const input = new TextInputBuilder()
    .setCustomId(IDS.statsWebhookInput)
    .setLabel('Webhook URL (leave blank to clear)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://discord.com/api/webhooks/...')
    .setRequired(false);
  if (current) {
    input.setValue(current);
  }

  return new ModalBuilder()
    .setCustomId(IDS.statsWebhookModal)
    .setTitle('Stats Digest Webhook')
    .addComponents(new ActionRowBuilder().addComponents(input) as ActionRowBuilder<TextInputBuilder>);
};

// Which category a field customId belongs to, so a value change knows which
// screen to re-render with its confirmation banner.
export const categoryForCustomId = (customId: string): CategoryId => {
  if (customId.startsWith('config:cleanup:')) {
    return 'cleanup';
  }

  if (customId.startsWith('config:dj:')) {
    return 'dj';
  }

  if (customId.startsWith('config:playback:')) {
    return 'playback';
  }

  if (customId.startsWith('config:voice:')) {
    return 'voice';
  }

  if (customId.startsWith('config:ambience:')) {
    return 'ambience';
  }

  return 'stats';
};

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('config')
    .setDescription('guided settings menu: playback, voice, ambience, cleanup, DJ, and stats digest')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild!.id;

    // Ensure guild settings exist before trying to read/update.
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
    // awaits below can't be parallelized. Wrapped in try/finally so a
    // mid-wizard throw (e.g. a transient DB error in handleComponent)
    // still clears the components instead of leaving a zombie ephemeral
    // message with live-looking but dead controls.
    try {
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

        // The webhook button opens a modal instead of updating this message
        // directly -- ModalSubmitInteraction is a separate interaction from
        // the button click, so it has to respond to (and re-render) the
        // message itself once the modal comes back. handleWebhookModal owns
        // that whole round-trip, so the generic component.update() below
        // must be skipped for it.
        if (component.customId === IDS.statsWebhookEdit) {
          // eslint-disable-next-line no-await-in-loop
          await this.handleWebhookModal(component, guildId);
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const screen = await this.handleComponent(component, guildId);
        // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment
        await component.update({embeds: screen.embeds, components: screen.components as any});
      }
    } finally {
      await interaction.editReply({components: []}).catch(() => undefined);
    }
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

  // Shows the webhook modal from the stats screen's button, waits for its
  // submission (or lets it time out / get dismissed with no changes), then
  // re-renders the stats screen on the ModalSubmitInteraction itself.
  private async handleWebhookModal(component: MessageComponentInteraction, guildId: string): Promise<void> {
    const setting = await getGuildSettings(guildId);
    // Same discord.js@14.11 cross-package discord-api-types version friction
    // as the components casts elsewhere in this file (ModalBuilder here
    // comes from a different discord-api-types copy than showModal expects).
    await component.showModal(buildWebhookModal(setting.statsWebhookUrl) as any);

    let modalSubmit: ModalSubmitInteraction;
    try {
      modalSubmit = await component.awaitModalSubmit({
        filter: i => i.user.id === component.user.id,
        time: MODAL_TIMEOUT_MS,
      });
    } catch {
      // Dismissed or timed out -- showModal() already acked the button
      // click, and the underlying message is untouched, so there's nothing
      // left to do; the outer loop just keeps waiting on that message.
      return;
    }

    const result = validateWebhookUrl(modalSubmit.fields.getTextInputValue(IDS.statsWebhookInput));

    let confirmation: string;
    let icon: string | undefined;
    if (result.ok) {
      await prisma.setting.update({where: {guildId}, data: {statsWebhookUrl: result.url}});
      confirmation = result.url ? 'Stats webhook is now set.' : 'Stats webhook cleared.';
    } else {
      confirmation = `${result.error} Webhook left unchanged.`;
      icon = '⚠️';
    }

    const updatedSetting = await getGuildSettings(guildId);
    const screen = buildStatsScreen(updatedSetting, confirmation, icon);

    if (modalSubmit.isFromMessage()) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      await modalSubmit.update({embeds: screen.embeds, components: screen.components as any});
    }
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

      case 'playback': {
        return buildPlaybackScreen(setting, confirmation);
      }

      case 'voice': {
        return buildVoiceScreen(setting, confirmation);
      }

      case 'ambience': {
        return buildAmbienceScreen(setting, confirmation);
      }

      case 'view-all': {
        const dj = await getDjSettings(guildId);
        return buildViewAllScreen(setting, dj);
      }

      default: {
        throw new Error(`unknown settings category: ${category as string}`);
      }
    }
  }

  // Dispatches to one small per-category handler instead of one giant
  // switch -- keeps each handler's cyclomatic complexity well under the
  // lint ceiling now that there are 6 categories' worth of controls instead
  // of the original 3.
  private async applyChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (categoryForCustomId(customId)) {
      case 'cleanup': return this.applyCleanupChange(customId, value, guildId);
      case 'dj': return this.applyDjChange(customId, value, guildId);
      case 'playback': return this.applyPlaybackChange(customId, value, guildId);
      case 'voice': return this.applyVoiceChange(customId, value, guildId);
      case 'ambience': return this.applyAmbienceChange(customId, value, guildId);
      default: return this.applyStatsChange(customId, value, guildId);
    }
  }

  private async applyCleanupChange(customId: string, value: string, guildId: string): Promise<string> {
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

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }

  private async applyDjChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
      case IDS.djEnabled: {
        const enabled = value === 'true';
        await updateDjSettings(guildId, {enabled});
        return `Auto-DJ is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.djMinQueueSize: {
        const size = Number(value);
        await updateDjSettings(guildId, {minQueueSize: size});
        return `Auto-DJ will now keep **${size}** song(s) queued, requesting that many new tracks each time it triggers.`;
      }

      case IDS.djChannel: {
        await prisma.setting.update({where: {guildId}, data: {djChannelId: value}});
        return `DJ messages will now be sent to <#${value}>.`;
      }

      case IDS.djClearChannel: {
        await prisma.setting.update({where: {guildId}, data: {djChannelId: null}});
        return 'DJ messages will follow the active voice channel again.';
      }

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }

  private async applyStatsChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
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

  private async applyPlaybackChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
      case IDS.playbackDefaultVolume: {
        const level = Number(value);
        await prisma.setting.update({where: {guildId}, data: {defaultVolume: level}});
        return `Default volume is now **${level}%**.`;
      }

      case IDS.playbackQueuePageSize: {
        const size = Number(value);
        await prisma.setting.update({where: {guildId}, data: {defaultQueuePageSize: size}});
        return `Queue page size is now **${size}**.`;
      }

      case IDS.playbackPlaylistLimit: {
        const limit = Number(value);
        await prisma.setting.update({where: {guildId}, data: {playlistLimit: limit}});
        return `Playlist add limit is now **${limit} tracks**.`;
      }

      case IDS.playbackQueueAddEphemeral: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {queueAddResponseEphemeral: enabled}});
        return `Queue-add responses are now **${enabled ? 'private' : 'public'}**.`;
      }

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }

  private async applyVoiceChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
      case IDS.voiceLeaveIfNoListeners: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {leaveIfNoListeners: enabled}});
        return `Leave when no listeners is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.voiceWaitAfterEmpty: {
        const seconds = Number(value);
        await prisma.setting.update({where: {guildId}, data: {secondsToWaitAfterQueueEmpties: seconds}});
        return `Wait after queue empties is now **${formatWaitAfterEmpty(seconds)}**.`;
      }

      case IDS.voiceAutoAnnounce: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {autoAnnounceNextSong: enabled}});
        return `Auto-announce next song is now **${formatYesNo(enabled)}**.`;
      }

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }

  private async applyAmbienceChange(customId: string, value: string, guildId: string): Promise<string> {
    switch (customId) {
      case IDS.ambienceDuckEnabled: {
        const enabled = value === 'true';
        await prisma.setting.update({where: {guildId}, data: {turnDownVolumeWhenPeopleSpeak: enabled}});
        return `Turn down volume when people speak is now **${formatYesNo(enabled)}**.`;
      }

      case IDS.ambienceDuckTarget: {
        const target = Number(value);
        await prisma.setting.update({where: {guildId}, data: {turnDownVolumeWhenPeopleSpeakTarget: target}});
        return `Target volume while speaking is now **${target}%**.`;
      }

      default: {
        throw new Error(`unhandled settings control: ${customId}`);
      }
    }
  }
}
