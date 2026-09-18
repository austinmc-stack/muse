import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {PermissionFlagsBits} from 'discord.js';
import type {ChatInputCommandInteraction} from 'discord.js';

const mocks = vi.hoisted(() => ({
  getGuildSettings: vi.fn(),
  getDjSettings: vi.fn(),
  updateDjSettings: vi.fn(),
  settingUpdate: vi.fn(),
}));

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: mocks.getGuildSettings,
}));

vi.mock('../src/utils/get-dj-settings.js', () => ({
  getDjSettings: mocks.getDjSettings,
  updateDjSettings: mocks.updateDjSettings,
}));

vi.mock('../src/utils/db.js', () => ({
  prisma: {
    setting: {update: mocks.settingUpdate},
  },
}));

import MuseSettings, {
  buildCleanupScreen,
  buildDjScreen,
  buildStatsScreen,
  buildTopScreen,
  categoryForCustomId,
  formatCleanupMode,
  formatDjChannel,
  formatYesNo,
} from '../src/commands/muse-settings.js';

const baseSetting = {
  cleanupMode: 'DJ_ONLY' as const,
  ephemeralDelaySeconds: 45,
  cleanupOnSessionEnd: true,
  statsDigestEnabled: false,
  statsDigestCadenceDays: 7,
  statsDigestDmOwner: false,
  statsWebhookUrl: null as string | null,
  djChannelId: null as string | null,
};

const baseDj = {enabled: false, minQueueSize: 2};

describe('pure formatting helpers', () => {
  it('formats booleans as On/Off', () => {
    expect(formatYesNo(true)).toBe('On');
    expect(formatYesNo(false)).toBe('Off');
  });

  it('formats cleanup mode in plain language', () => {
    expect(formatCleanupMode('NONE')).toBe('None (never clean up)');
    expect(formatCleanupMode('DJ_ONLY')).toBe('DJ messages only');
    expect(formatCleanupMode('ALL_BOT_MESSAGES')).toBe('All bot messages');
  });

  it('formats the DJ channel as a mention, or a fallback when unset', () => {
    expect(formatDjChannel('123')).toBe('<#123>');
    expect(formatDjChannel(null)).toBe('follows the active voice channel');
  });

  it('maps each field customId to its owning category', () => {
    expect(categoryForCustomId('muse-settings:cleanup:mode')).toBe('cleanup');
    expect(categoryForCustomId('muse-settings:dj:channel')).toBe('dj');
    expect(categoryForCustomId('muse-settings:dj:clear-channel')).toBe('dj');
    expect(categoryForCustomId('muse-settings:stats:enabled')).toBe('stats');
  });
});

describe('screen builders', () => {
  it('shows exactly the 3 categories on the top screen (Hick\'s law: few top-level choices)', () => {
    const {embeds, components} = buildTopScreen();
    const json = components[0].toJSON() as {components: Array<{options: Array<{value: string}>}>};
    const values = json.components[0].options.map(o => o.value);

    expect(values).toEqual(['cleanup', 'dj', 'stats']);
    expect(embeds[0].toJSON().title).toContain('Muse Settings');
  });

  it('color-codes the cleanup screen green when active, grey when off', () => {
    const active = buildCleanupScreen({...baseSetting, cleanupMode: 'ALL_BOT_MESSAGES'});
    const off = buildCleanupScreen({...baseSetting, cleanupMode: 'NONE'});

    expect(active.embeds[0].toJSON().color).toBe(0x57f287); // Colors.Green
    expect(off.embeds[0].toJSON().color).toBe(0x95a5a6); // Colors.Grey
  });

  it('prepends a plain-language confirmation banner without losing the current values', () => {
    const screen = buildCleanupScreen(baseSetting, 'Cleanup mode is now **DJ messages only**.');
    const description = screen.embeds[0].toJSON().description!;

    expect(description.startsWith('✅ Cleanup mode is now **DJ messages only**.')).toBe(true);
    expect(description).toContain('**Auto-delete delay:** 45s');
  });

  it('keeps each screen to 4 action rows or fewer (Miller\'s law: a handful of choices per screen)', () => {
    for (const screen of [
      buildCleanupScreen(baseSetting),
      buildDjScreen(baseSetting, baseDj),
      buildStatsScreen(baseSetting),
    ]) {
      expect(screen.components.length).toBeLessThanOrEqual(5);
    }
  });

  it('echoes the DJ channel as a mention once set, matching the brief\'s example wording', () => {
    const screen = buildDjScreen({...baseSetting, djChannelId: '999'}, baseDj);
    expect(screen.embeds[0].toJSON().description).toContain('**Message channel:** <#999>');
  });

  it('points to /config set-stats-webhook instead of a fake free-text control', () => {
    const screen = buildStatsScreen(baseSetting);
    expect(screen.embeds[0].toJSON().footer?.text).toContain('/config set-stats-webhook');
  });
});

describe('slash command metadata', () => {
  it('registers as /muse-settings, restricted to Manage Guild', () => {
    const json = new MuseSettings().slashCommand.toJSON();

    expect(json.name).toBe('muse-settings');
    expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });
});

describe('execute() end-to-end wizard flow', () => {
  const GUILD_ID = 'guild-1';
  const USER_ID = 'user-1';

  const isStringSelectMenu = () => true;
  const isChannelSelectMenu = () => false;
  const isButton = () => false;

  const makeComponent = (customId: string, values: string[] = []) => ({
    customId,
    values,
    user: {id: USER_ID},
    isStringSelectMenu,
    isChannelSelectMenu,
    isButton,
    update: vi.fn().mockResolvedValue(undefined),
  });

  let liveSetting: typeof baseSetting;
  let liveDj: typeof baseDj;

  beforeEach(() => {
    vi.clearAllMocks();
    liveSetting = {...baseSetting};
    liveDj = {...baseDj};

    mocks.getGuildSettings.mockImplementation(async () => liveSetting);
    mocks.getDjSettings.mockImplementation(async () => liveDj);
    mocks.settingUpdate.mockImplementation(async ({data}: {data: Partial<typeof baseSetting>}) => {
      Object.assign(liveSetting, data);
      return liveSetting;
    });
    mocks.updateDjSettings.mockImplementation(async (_guildId: string, data: Partial<typeof baseDj>) => {
      Object.assign(liveDj, data);
      return liveDj;
    });
  });

  const runWizard = async (queue: Array<ReturnType<typeof makeComponent>>) => {
    const remaining = [...queue];
    const message = {
      awaitMessageComponent: vi.fn(async () => {
        const next = remaining.shift();
        if (!next) {
          throw new Error('timed out');
        }

        return next;
      }),
    };
    const reply = vi.fn().mockResolvedValue(message);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guild: {id: GUILD_ID},
      user: {id: USER_ID},
      reply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await new MuseSettings().execute(interaction);

    return {reply, editReply, message};
  };

  it('opens an ephemeral top-level menu', async () => {
    const {reply} = await runWizard([]);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ephemeral: true, fetchReply: true}));
  });

  it('drills into DJ, sets the channel, and echoes back the exact wording the brief asks for', async () => {
    const category = makeComponent('muse-settings:category', ['dj']);
    const channelPick = {
      ...makeComponent('muse-settings:dj:channel', ['555']),
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => true,
    };

    const {message} = await runWizard([category, channelPick]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {djChannelId: '555'}});

    const confirmationCall = channelPick.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
    expect(confirmationCall.embeds[0].toJSON().description).toContain('DJ messages will now be sent to <#555>.');
    expect(message.awaitMessageComponent).toHaveBeenCalledTimes(3); // Category, channel pick, then the timeout that ends the loop
  });

  it('round-trips: reopening the DJ screen after a change shows the new value', async () => {
    const category = makeComponent('muse-settings:category', ['dj']);
    const enableDj = makeComponent('muse-settings:dj:enabled', ['true']);
    const backToTop = makeComponent('muse-settings:back');
    const category2 = makeComponent('muse-settings:category', ['dj']);

    await runWizard([category, enableDj, backToTop, category2]);

    const reopenedScreen = category2.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
    expect(reopenedScreen.embeds[0].toJSON().description).toContain('**Auto-DJ:** On');
  });

  it('sets cleanup mode and applies the write to the right guild', async () => {
    const category = makeComponent('muse-settings:category', ['cleanup']);
    const setMode = makeComponent('muse-settings:cleanup:mode', ['ALL_BOT_MESSAGES']);

    await runWizard([category, setMode]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {cleanupMode: 'ALL_BOT_MESSAGES'}});
  });

  it('clears the DJ channel via the button with no select value', async () => {
    const category = makeComponent('muse-settings:category', ['dj']);
    const clearButton = {
      ...makeComponent('muse-settings:dj:clear-channel'),
      isStringSelectMenu: () => false,
      isButton: () => true,
    };

    await runWizard([category, clearButton]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {djChannelId: null}});
  });

  it('clears the components on the ephemeral message once the session times out', async () => {
    const {editReply} = await runWizard([]);

    expect(editReply).toHaveBeenCalledWith({components: []});
  });
});
