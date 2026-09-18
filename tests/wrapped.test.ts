import {describe, expect, it, vi} from 'vitest';

const makePrismaMock = () => ({
  artistGenreCache: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  playHistoryListener: {
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
});

const loadModules = async (prismaMock: ReturnType<typeof makePrismaMock>) => {
  vi.resetModules();
  vi.doMock('@prisma/client', () => ({
    PrismaClient: class {
      artistGenreCache = prismaMock.artistGenreCache;
      playHistoryListener = prismaMock.playHistoryListener;
    },
  }));
  const {default: WrappedTracker} = await import('../src/services/wrapped-tracker.js');
  const {default: WrappedService} = await import('../src/services/wrapped-service.js');
  return {WrappedService, WrappedTracker};
};

const resetHarness = () => {
  vi.doUnmock('@prisma/client');
  vi.resetModules();
};

describe('WrappedTracker.recordListeners', () => {
  it('does nothing when no one is present', async () => {
    const prismaMock = makePrismaMock();

    try {
      const {WrappedTracker} = await loadModules(prismaMock);
      await new WrappedTracker().recordListeners(1, 'guild-1', 'requester-id', []);

      expect(prismaMock.playHistoryListener.createMany).not.toHaveBeenCalled();
    } finally {
      resetHarness();
    }
  });

  it('tags the requester REQUESTER and everyone else LISTENER, skipping duplicates', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.createMany.mockResolvedValue({count: 3});

    try {
      const {WrappedTracker} = await loadModules(prismaMock);
      await new WrappedTracker().recordListeners(42, 'guild-1', 'requester-id', ['requester-id', 'listener-a', 'listener-b']);

      expect(prismaMock.playHistoryListener.createMany).toHaveBeenCalledWith({
        data: [
          {playHistoryId: 42, guildId: 'guild-1', userId: 'requester-id', role: 'REQUESTER'},
          {playHistoryId: 42, guildId: 'guild-1', userId: 'listener-a', role: 'LISTENER'},
          {playHistoryId: 42, guildId: 'guild-1', userId: 'listener-b', role: 'LISTENER'},
        ],
        skipDuplicates: true,
      });
    } finally {
      resetHarness();
    }
  });

  it('tags everyone LISTENER for a DJ auto-pick (no requester)', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.createMany.mockResolvedValue({count: 1});

    try {
      const {WrappedTracker} = await loadModules(prismaMock);
      await new WrappedTracker().recordListeners(42, 'guild-1', null, ['listener-a']);

      expect(prismaMock.playHistoryListener.createMany).toHaveBeenCalledWith({
        data: [{playHistoryId: 42, guildId: 'guild-1', userId: 'listener-a', role: 'LISTENER'}],
        skipDuplicates: true,
      });
    } finally {
      resetHarness();
    }
  });

  it('swallows a write failure instead of throwing', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.createMany.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const {WrappedTracker} = await loadModules(prismaMock);
      await expect(new WrappedTracker().recordListeners(1, 'guild-1', null, ['a'])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      resetHarness();
    }
  });
});

describe('WrappedService.generate', () => {
  const makeListenerRow = (title: string, artist: string, msPlayed: number, durationMs: number) => ({
    playHistory: {artist, durationMs, msPlayed, title},
  });

  it('scopes the query to the requesting user and, when given, the guild', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.findMany.mockResolvedValue([]);

    try {
      const {WrappedService} = await loadModules(prismaMock);
      await new WrappedService().generate('user-1', 2026, 'guild-1');

      expect(prismaMock.playHistoryListener.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({userId: 'user-1', guildId: 'guild-1'}),
      }));
    } finally {
      resetHarness();
    }
  });

  it('sums listened time and counts plays across every row this user was present for', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.findMany.mockResolvedValue([
      makeListenerRow('Song A', 'Artist A', 180_000, 200_000),
      makeListenerRow('Song B', 'Artist A', 120_000, 200_000),
    ]);

    try {
      const {WrappedService} = await loadModules(prismaMock);
      const summary = await new WrappedService().generate('user-1', 2026);

      expect(summary.totalMinutesListened).toBe(5); // (180000+120000)/60000
      expect(summary.totalTracksPlayed).toBe(2);
      expect(summary.topArtists[0]).toEqual({artist: 'Artist A', playCount: 2});
    } finally {
      resetHarness();
    }
  });

  it('excludes a play from top-tracks ranking when it falls under the completion ratio', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.findMany.mockResolvedValue([
      makeListenerRow('Skipped early', 'Artist A', 10_000, 200_000), // 5% completion
      makeListenerRow('Finished', 'Artist B', 190_000, 200_000), // 95% completion
    ]);

    try {
      const {WrappedService} = await loadModules(prismaMock);
      const summary = await new WrappedService().generate('user-1', 2026);

      expect(summary.topTracks).toEqual([{artist: 'Artist B', title: 'Finished', playCount: 1}]);
    } finally {
      resetHarness();
    }
  });
});

describe('WrappedService.generateGuildDigest', () => {
  const makeListenerRow = (userId: string, title: string, artist: string, msPlayed: number, durationMs: number) => ({
    userId,
    playHistory: {artist, durationMs, msPlayed, title},
  });

  it('scopes the query to the guild and the given time window', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.findMany.mockResolvedValue([]);
    const since = new Date('2026-01-01');

    try {
      const {WrappedService} = await loadModules(prismaMock);
      await new WrappedService().generateGuildDigest('guild-1', since);

      expect(prismaMock.playHistoryListener.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          guildId: 'guild-1',
          playHistory: expect.objectContaining({playedAt: {gte: since}}),
        }),
      }));
    } finally {
      resetHarness();
    }
  });

  it('ranks listeners by total time listened, most first', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistoryListener.findMany.mockResolvedValue([
      makeListenerRow('user-a', 'Song 1', 'Artist', 60_000, 100_000),
      makeListenerRow('user-b', 'Song 1', 'Artist', 300_000, 300_000),
      makeListenerRow('user-a', 'Song 2', 'Artist', 60_000, 100_000),
    ]);

    try {
      const {WrappedService} = await loadModules(prismaMock);
      const summary = await new WrappedService().generateGuildDigest('guild-1', new Date(0));

      expect(summary.topListeners).toEqual([
        {userId: 'user-b', minutesListened: 5, trackCount: 1},
        {userId: 'user-a', minutesListened: 2, trackCount: 2},
      ]);
      expect(summary.totalTracksPlayed).toBe(3);
    } finally {
      resetHarness();
    }
  });
});
