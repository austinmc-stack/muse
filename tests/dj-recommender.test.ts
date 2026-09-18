import {describe, expect, it, vi} from 'vitest';

const makePrismaMock = () => ({
  playHistory: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  trackCooccurrence: {
    findMany: vi.fn(),
  },
});

const loadDjRecommender = async (prismaMock: ReturnType<typeof makePrismaMock>) => {
  vi.resetModules();
  vi.doMock('@prisma/client', () => ({
    PrismaClient: class {
      playHistory = prismaMock.playHistory;
      trackCooccurrence = prismaMock.trackCooccurrence;
    },
  }));
  const {default: DjRecommender} = await import('../src/services/dj-recommender.js');
  return new DjRecommender();
};

const resetHarness = () => {
  vi.doUnmock('@prisma/client');
  vi.resetModules();
};

describe('DjRecommender guild isolation', () => {
  it('scopes the co-occurrence lookup to the requesting guild', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistory.findMany.mockResolvedValue([
      {artist: 'Artist A', guildId: 'guild-1', playedAt: new Date(), youtubeId: 'seed-1'},
    ]);
    prismaMock.trackCooccurrence.findMany.mockResolvedValue([]);

    try {
      const recommender = await loadDjRecommender(prismaMock);
      await recommender.recommendNext('guild-1', 2).catch(() => undefined);

      expect(prismaMock.trackCooccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({guildId: 'guild-1'}),
        }),
      );
    } finally {
      resetHarness();
    }
  });

  it('scopes the same-artist fallback signal to the requesting guild', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistory.findMany
      .mockResolvedValueOnce([
        {artist: 'Artist A', guildId: 'guild-1', playedAt: new Date(), youtubeId: 'seed-1'},
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackCooccurrence.findMany.mockResolvedValue([]);

    try {
      const recommender = await loadDjRecommender(prismaMock);
      await recommender.recommendNext('guild-1', 2).catch(() => undefined);

      expect(prismaMock.playHistory.findMany).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          where: expect.objectContaining({artist: 'Artist A', guildId: 'guild-1'}),
        }),
      );
    } finally {
      resetHarness();
    }
  });

  it('scopes the co-occurrence candidate metadata lookup to the requesting guild', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistory.findMany
      .mockResolvedValueOnce([
        {artist: 'Artist A', guildId: 'guild-1', playedAt: new Date(), youtubeId: 'seed-1'},
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackCooccurrence.findMany.mockResolvedValue([
      {guildId: 'guild-1', sampleSize: 3, score: 3, youtubeIdA: 'seed-1', youtubeIdB: 'candidate-1'},
    ]);
    prismaMock.playHistory.findFirst.mockResolvedValue({
      artist: 'Artist B', guildId: 'guild-1', title: 'Candidate', youtubeId: 'candidate-1',
    });

    try {
      const recommender = await loadDjRecommender(prismaMock);
      await recommender.recommendNext('guild-1', 1);

      expect(prismaMock.playHistory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({guildId: 'guild-1', youtubeId: 'candidate-1'}),
        }),
      );
    } finally {
      resetHarness();
    }
  });
});

describe('DjRecommender no-repeat filter', () => {
  it('excludes currently-queued tracks from the co-occurrence and same-artist candidate queries', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistory.findMany
      .mockResolvedValueOnce([
        {artist: 'Artist A', guildId: 'guild-1', playedAt: new Date(), youtubeId: 'seed-1'},
      ])
      .mockResolvedValueOnce([]);
    prismaMock.trackCooccurrence.findMany.mockResolvedValue([]);

    try {
      const recommender = await loadDjRecommender(prismaMock);
      await recommender.recommendNext('guild-1', 2, ['queued-1']).catch(() => undefined);

      expect(prismaMock.trackCooccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({youtubeIdB: {notIn: expect.arrayContaining(['seed-1', 'queued-1'])}}),
        }),
      );
      expect(prismaMock.playHistory.findMany).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          where: expect.objectContaining({youtubeId: {notIn: expect.arrayContaining(['seed-1', 'queued-1'])}}),
        }),
      );
    } finally {
      resetHarness();
    }
  });

  it('falls back to allowing repeats of queued tracks rather than throwing when the exclusion empties the pool', async () => {
    const prismaMock = makePrismaMock();
    prismaMock.playHistory.findMany
      // Seed history
      .mockResolvedValueOnce([
        {artist: 'Artist A', guildId: 'guild-1', playedAt: new Date(), youtubeId: 'only-track'},
      ])
      // Same-artist signal, empty
      .mockResolvedValueOnce([])
      // First fallback tier (excludes played + queued) -- empty, tiny library
      .mockResolvedValueOnce([])
      // Second fallback tier (excludes only played) -- has the one track, since
      // it's only sitting in the queue, not actually played yet
      .mockResolvedValueOnce([
        {artist: 'Artist A', guildId: 'guild-1', title: 'Only Track', youtubeId: 'only-track', playedAt: new Date()},
      ]);
    prismaMock.trackCooccurrence.findMany.mockResolvedValue([]);

    try {
      const recommender = await loadDjRecommender(prismaMock);
      const picks = await recommender.recommendNext('guild-1', 1, ['only-track']);

      expect(picks).toHaveLength(1);
      expect(picks[0].youtubeId).toBe('only-track');
    } finally {
      resetHarness();
    }
  });
});
