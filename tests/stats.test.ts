import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/utils/build-embed.js', () => ({
  buildStatsDigestEmbed: vi.fn((summary, label) => ({title: `digest-${label}`, summary})),
}));

import Stats from '../src/commands/stats.js';

const makeInteraction = (overrides: Record<string, unknown> = {}) => ({
  guild: {id: 'guild-1'},
  user: {id: 'user-1'},
  options: {
    getSubcommand: vi.fn(() => 'digest'),
    getInteger: vi.fn(() => null),
    getString: vi.fn(() => null),
    getBoolean: vi.fn(() => false),
  },
  reply: vi.fn().mockResolvedValue(undefined),
  deferReply: vi.fn().mockResolvedValue(undefined),
  editReply: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('/stats digest and leaderboard', () => {
  it('builds a digest for the default 7-day window', async () => {
    const wrappedService = {generateGuildDigest: vi.fn().mockResolvedValue({totalTracksPlayed: 3})};
    const command = new Stats(wrappedService as never, {} as never);
    const interaction = makeInteraction();

    await command.execute(interaction as never);

    expect(wrappedService.generateGuildDigest).toHaveBeenCalledWith('guild-1', expect.any(Date));
    expect(interaction.reply).toHaveBeenCalledWith({embeds: [expect.objectContaining({title: 'digest-past 7 day(s)'})]});
  });

  it('uses the alltime scope (epoch) for the leaderboard when requested', async () => {
    const wrappedService = {generateGuildDigest: vi.fn().mockResolvedValue({totalTracksPlayed: 1})};
    const command = new Stats(wrappedService as never, {} as never);
    const interaction = makeInteraction({
      options: {
        getSubcommand: vi.fn(() => 'leaderboard'),
        getString: vi.fn(() => 'alltime'),
      },
    });

    await command.execute(interaction as never);

    expect(wrappedService.generateGuildDigest).toHaveBeenCalledWith('guild-1', new Date(0));
  });
});

describe('/stats wrapped', () => {
  it('generates the requesting user\'s own-year summary and replies with rendered cards', async () => {
    const wrappedService = {generate: vi.fn().mockResolvedValue({year: 2026})};
    const wrappedCardRenderer = {renderCards: vi.fn().mockResolvedValue([Buffer.from('card')])};
    const command = new Stats(wrappedService as never, wrappedCardRenderer as never);
    const interaction = makeInteraction({
      options: {
        getSubcommand: vi.fn(() => 'wrapped'),
        getInteger: vi.fn(() => 2026),
        getBoolean: vi.fn(() => false),
      },
    });

    await command.execute(interaction as never);

    expect(wrappedService.generate).toHaveBeenCalledWith('user-1', 2026, undefined);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({files: [expect.anything()]});
  });

  it('scopes to the current guild when server-only is set', async () => {
    const wrappedService = {generate: vi.fn().mockResolvedValue({year: 2026})};
    const wrappedCardRenderer = {renderCards: vi.fn().mockResolvedValue([])};
    const command = new Stats(wrappedService as never, wrappedCardRenderer as never);
    const interaction = makeInteraction({
      options: {
        getSubcommand: vi.fn(() => 'wrapped'),
        getInteger: vi.fn(() => null),
        getBoolean: vi.fn(() => true),
      },
    });

    await command.execute(interaction as never);

    expect(wrappedService.generate).toHaveBeenCalledWith('user-1', new Date().getFullYear(), 'guild-1');
  });
});
