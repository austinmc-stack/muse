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

import Config, {
  buildAmbienceScreen,
  buildCleanupScreen,
  buildDjScreen,
  buildPlaybackScreen,
  buildStatsScreen,
  buildTopScreen,
  buildViewAllScreen,
  buildVoiceScreen,
  categoryForCustomId,
  formatCleanupMode,
  formatDjChannel,
  formatWaitAfterEmpty,
  formatYesNo,
  validateWebhookUrl,
} from '../src/commands/config.js';

const baseSetting = {
  cleanupMode: 'DJ_ONLY' as const,
  ephemeralDelaySeconds: 45,
  cleanupOnSessionEnd: true,
  statsDigestEnabled: false,
  statsDigestCadenceDays: 7,
  statsDigestDmOwner: false,
  statsWebhookUrl: null as string | null,
  djChannelId: null as string | null,
  playlistLimit: 50,
  secondsToWaitAfterQueueEmpties: 30,
  leaveIfNoListeners: true,
  queueAddResponseEphemeral: false,
  defaultVolume: 100,
  defaultQueuePageSize: 10,
  turnDownVolumeWhenPeopleSpeak: false,
  turnDownVolumeWhenPeopleSpeakTarget: 20,
  autoAnnounceNextSong: false,
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
    expect(categoryForCustomId('config:cleanup:mode')).toBe('cleanup');
    expect(categoryForCustomId('config:dj:channel')).toBe('dj');
    expect(categoryForCustomId('config:dj:clear-channel')).toBe('dj');
    expect(categoryForCustomId('config:stats:enabled')).toBe('stats');
    expect(categoryForCustomId('config:playback:default-volume')).toBe('playback');
    expect(categoryForCustomId('config:voice:leave-if-no-listeners')).toBe('voice');
    expect(categoryForCustomId('config:ambience:duck-enabled')).toBe('ambience');
  });

  it('formats the never-leave case for wait-after-queue-empties', () => {
    expect(formatWaitAfterEmpty(0)).toBe('never (stays until manually stopped)');
    expect(formatWaitAfterEmpty(30)).toBe('30s');
  });
});

describe('validateWebhookUrl', () => {
  it('treats a blank field as "clear the webhook", not an error', () => {
    expect(validateWebhookUrl('')).toEqual({ok: true, url: null});
    expect(validateWebhookUrl('   ')).toEqual({ok: true, url: null});
  });

  it('accepts a well-formed http(s) URL, trimmed', () => {
    expect(validateWebhookUrl('  https://example.com/hook  ')).toEqual({ok: true, url: 'https://example.com/hook'});
    expect(validateWebhookUrl('http://example.com/hook')).toEqual({ok: true, url: 'http://example.com/hook'});
  });

  it('rejects garbage input instead of silently saving it', () => {
    const result = validateWebhookUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    const result = validateWebhookUrl('ftp://example.com/hook');
    expect(result.ok).toBe(false);
  });
});

describe('screen builders', () => {
  it('shows all 7 categories on the top screen -- at Miller\'s law\'s upper bound, in one select row', () => {
    const {embeds, components} = buildTopScreen();
    const json = components[0].toJSON() as {components: Array<{options: Array<{value: string}>}>};
    const values = json.components[0].options.map(o => o.value);

    expect(values).toEqual(['playback', 'voice', 'ambience', 'cleanup', 'dj', 'stats', 'view-all']);
    expect(components).toHaveLength(1); // Still one row: a select can hold many options without adding rows
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

  it('keeps every screen to 5 action rows or fewer -- Discord\'s hard per-message cap', () => {
    for (const screen of [
      buildCleanupScreen(baseSetting),
      buildDjScreen(baseSetting, baseDj),
      buildStatsScreen(baseSetting),
      buildPlaybackScreen(baseSetting),
      buildVoiceScreen(baseSetting),
      buildAmbienceScreen(baseSetting),
      buildAmbienceScreen({...baseSetting, turnDownVolumeWhenPeopleSpeak: true}),
      buildViewAllScreen(baseSetting, baseDj),
    ]) {
      expect(screen.components.length).toBeLessThanOrEqual(5);
    }
  });

  it('shows every setting the old /config set-* subcommands covered, now via the wizard', () => {
    const playback = buildPlaybackScreen({...baseSetting, defaultVolume: 75, defaultQueuePageSize: 15, playlistLimit: 25, queueAddResponseEphemeral: true});
    const description = playback.embeds[0].toJSON().description!;
    expect(description).toContain('**Default volume:** 75%');
    expect(description).toContain('**Queue page size:** 15');
    expect(description).toContain('**Playlist add limit:** 25 tracks');
    expect(description).toContain('Private (only you see them)');
  });

  it('renders the voice-presence screen with the never-leave wording', () => {
    const screen = buildVoiceScreen({...baseSetting, secondsToWaitAfterQueueEmpties: 0});
    expect(screen.embeds[0].toJSON().description).toContain('never (stays until manually stopped)');
  });

  it('only shows the duck-target select once ducking is turned on', () => {
    const off = buildAmbienceScreen(baseSetting);
    const on = buildAmbienceScreen({...baseSetting, turnDownVolumeWhenPeopleSpeak: true, turnDownVolumeWhenPeopleSpeakTarget: 30});

    expect(off.components).toHaveLength(2); // Enabled select + back
    expect(on.components).toHaveLength(3); // Enabled select + target select + back
    expect(on.embeds[0].toJSON().description).toContain('**Target volume while speaking:** 30%');
  });

  it('the view-all screen is read-only (no field controls, just a back button) and lists every setting', () => {
    const screen = buildViewAllScreen(baseSetting, baseDj);
    expect(screen.components).toHaveLength(1);

    const description = screen.embeds[0].toJSON().description!;
    for (const fragment of [
      '**Playlist add limit:** 50 tracks',
      '**Default volume:** 100%',
      '**Queue page size:** 10',
      '**Leave when no listeners:** On',
      '**Auto-announce next song:** Off',
      '**Turn down volume when people speak:** Off',
      '**Target volume while speaking:** 20%',
      '**Stats webhook:** not set',
    ]) {
      expect(description).toContain(fragment);
    }
  });

  it('echoes the DJ channel as a mention once set, matching the brief\'s example wording', () => {
    const screen = buildDjScreen({...baseSetting, djChannelId: '999'}, baseDj);
    expect(screen.embeds[0].toJSON().description).toContain('**Message channel:** <#999>');
  });

  it('reports webhook status without pointing at a removed subcommand', () => {
    const withWebhook = buildStatsScreen({...baseSetting, statsWebhookUrl: 'https://example.com/hook'});
    const withoutWebhook = buildStatsScreen(baseSetting);
    expect(withWebhook.embeds[0].toJSON().footer?.text).toContain('Webhook is set.');
    expect(withoutWebhook.embeds[0].toJSON().footer?.text).not.toContain('/config set-stats-webhook');
  });
});

describe('slash command metadata', () => {
  it('registers as /config with no subcommands, restricted to Manage Guild', () => {
    const json = new Config().slashCommand.toJSON();

    expect(json.name).toBe('config');
    expect(json.options ?? []).toHaveLength(0);
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

    await new Config().execute(interaction);

    return {reply, editReply, message};
  };

  it('opens an ephemeral top-level menu', async () => {
    const {reply} = await runWizard([]);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ephemeral: true, fetchReply: true}));
  });

  it('drills into DJ, sets the channel, and echoes back the exact wording the brief asks for', async () => {
    const category = makeComponent('config:category', ['dj']);
    const channelPick = {
      ...makeComponent('config:dj:channel', ['555']),
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
    const category = makeComponent('config:category', ['dj']);
    const enableDj = makeComponent('config:dj:enabled', ['true']);
    const backToTop = makeComponent('config:back');
    const category2 = makeComponent('config:category', ['dj']);

    await runWizard([category, enableDj, backToTop, category2]);

    const reopenedScreen = category2.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
    expect(reopenedScreen.embeds[0].toJSON().description).toContain('**Auto-DJ:** On');
  });

  it('sets cleanup mode and applies the write to the right guild', async () => {
    const category = makeComponent('config:category', ['cleanup']);
    const setMode = makeComponent('config:cleanup:mode', ['ALL_BOT_MESSAGES']);

    await runWizard([category, setMode]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {cleanupMode: 'ALL_BOT_MESSAGES'}});
  });

  it('clears the DJ channel via the button with no select value', async () => {
    const category = makeComponent('config:category', ['dj']);
    const clearButton = {
      ...makeComponent('config:dj:clear-channel'),
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

  it('sets a Playback field (playlistLimit), covering a setting the old subcommands exposed but the merge dropped', async () => {
    const category = makeComponent('config:category', ['playback']);
    const setLimit = makeComponent('config:playback:playlist-limit', ['100']);

    await runWizard([category, setLimit]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {playlistLimit: 100}});
  });

  it('sets a Voice Presence field (secondsToWaitAfterQueueEmpties)', async () => {
    const category = makeComponent('config:category', ['voice']);
    const setWait = makeComponent('config:voice:wait-after-empty', ['0']);

    await runWizard([category, setWait]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {secondsToWaitAfterQueueEmpties: 0}});
  });

  it('turning on Ambience ducking reveals the target select on the next render', async () => {
    const category = makeComponent('config:category', ['ambience']);
    const enableDuck = makeComponent('config:ambience:duck-enabled', ['true']);

    await runWizard([category, enableDuck]);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {turnDownVolumeWhenPeopleSpeak: true}});
    const rendered = enableDuck.update.mock.calls[0][0] as {components: unknown[]};
    expect(rendered.components).toHaveLength(3); // Enabled select + newly-revealed target select + back
  });

  it('reaches "View All" straight from the top-level select and shows it\'s read-only', async () => {
    const category = makeComponent('config:category', ['view-all']);
    const backToTop = makeComponent('config:back');

    const {message} = await runWizard([category, backToTop]);

    const rendered = category.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {title?: string; description?: string}}>; components: unknown[]};
    expect(rendered.embeds[0].toJSON().title).toContain('All Settings');
    expect(rendered.embeds[0].toJSON().description).toContain('**Playlist add limit:** 50 tracks');
    expect(rendered.components).toHaveLength(1); // Just the back button, no writable controls
    expect(message.awaitMessageComponent).toHaveBeenCalledTimes(3);
  });

  describe('stats webhook modal round-trip', () => {
    const makeWebhookButton = (currentUrl: string | null) => ({
      customId: 'config:stats:webhook-edit',
      user: {id: USER_ID},
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      isButton: () => true,
      showModal: vi.fn().mockResolvedValue(undefined),
      awaitModalSubmit: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      _currentUrl: currentUrl,
    });

    const makeModalSubmit = (submittedValue: string) => ({
      user: {id: USER_ID},
      fields: {getTextInputValue: vi.fn().mockReturnValue(submittedValue)},
      isFromMessage: () => true,
      update: vi.fn().mockResolvedValue(undefined),
    });

    it('opens the modal pre-filled with the current webhook, then saves a valid submitted URL', async () => {
      const category = makeComponent('config:category', ['stats']);
      const webhookButton = makeWebhookButton(null);
      const modalSubmit = makeModalSubmit('https://example.com/hook');
      webhookButton.awaitModalSubmit.mockResolvedValue(modalSubmit);

      await runWizard([category, webhookButton as any]);

      expect(webhookButton.showModal).toHaveBeenCalledTimes(1);
      expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {statsWebhookUrl: 'https://example.com/hook'}});

      // The button itself must never be .update()'d -- showModal() was its ack.
      expect(webhookButton.update).not.toHaveBeenCalled();
      const rendered = modalSubmit.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
      expect(rendered.embeds[0].toJSON().description).toContain('Stats webhook is now set.');
    });

    it('clears the webhook when the modal is submitted blank', async () => {
      const category = makeComponent('config:category', ['stats']);
      const webhookButton = makeWebhookButton('https://old.example.com/hook');
      const modalSubmit = makeModalSubmit('   ');
      webhookButton.awaitModalSubmit.mockResolvedValue(modalSubmit);
      liveSetting.statsWebhookUrl = 'https://old.example.com/hook';

      await runWizard([category, webhookButton as any]);

      expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: GUILD_ID}, data: {statsWebhookUrl: null}});
      const rendered = modalSubmit.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
      expect(rendered.embeds[0].toJSON().description).toContain('Stats webhook cleared.');
    });

    it('rejects an invalid submitted URL without touching the saved value', async () => {
      const category = makeComponent('config:category', ['stats']);
      const webhookButton = makeWebhookButton(null);
      const modalSubmit = makeModalSubmit('not a url');
      webhookButton.awaitModalSubmit.mockResolvedValue(modalSubmit);

      await runWizard([category, webhookButton as any]);

      expect(mocks.settingUpdate).not.toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({statsWebhookUrl: expect.anything()})}));
      const rendered = modalSubmit.update.mock.calls[0][0] as {embeds: Array<{toJSON: () => {description?: string}}>};
      expect(rendered.embeds[0].toJSON().description).toContain('Webhook left unchanged.');
    });

    it('leaves the message untouched if the modal is dismissed/times out', async () => {
      const category = makeComponent('config:category', ['stats']);
      const webhookButton = makeWebhookButton(null);
      webhookButton.awaitModalSubmit.mockRejectedValue(new Error('modal timed out'));
      const backToTop = makeComponent('config:back');

      const {message} = await runWizard([category, webhookButton as any, backToTop]);

      expect(mocks.settingUpdate).not.toHaveBeenCalled();
      expect(webhookButton.update).not.toHaveBeenCalled();
      // Loop kept waiting on the same message and picked up the next interaction.
      expect(message.awaitMessageComponent).toHaveBeenCalledTimes(4);
    });
  });
});
