// VC listener tracking: stats are driven by PlayHistoryListener, not
// PlayHistory directly -- one row per person actually in the voice channel
// per play (see that model's schema comment), so a passive listener gets
// Wrapped credit too, not just whoever typed the command. role='REQUESTER'
// marks the person who actually requested the track; everyone else present
// (including everyone, for a DJ auto-pick nobody specifically asked for)
// is role='LISTENER'.

import {injectable} from 'inversify';
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

export interface WrappedSummary {
  year: number;
  guildId: string | null;
  totalMinutesListened: number;
  totalTracksPlayed: number;
  topTracks: Array<{title: string; artist: string; playCount: number}>;
  topArtists: Array<{artist: string; playCount: number}>;
  topGenre: string | null;
  listeningPersonality: string;
}

export interface GuildDigestSummary {
  guildId: string;
  since: Date;
  totalMinutesListened: number;
  totalTracksPlayed: number;
  topListeners: Array<{userId: string; minutesListened: number; trackCount: number}>;
  topTracks: Array<{title: string; artist: string; playCount: number}>;
  topArtists: Array<{artist: string; playCount: number}>;
}

const MIN_COMPLETION_RATIO = 0.5;
const TOP_N = 5;

type Play = {title: string; artist: string; msPlayed: number | null; durationMs: number | null};

// Shared by generate() (per-user, yearly) and generateGuildDigest()
// (guild-wide, rolling window) so "what counts as a real play" and "how
// top tracks/artists get ranked" can't drift between the two.
function rankTracksAndArtists(plays: Play[], limit: number): {
  topTracks: Array<{title: string; artist: string; playCount: number}>;
  topArtists: Array<{artist: string; playCount: number}>;
  realPlayCount: number;
} {
  const realPlays = plays.filter(play =>
    play.durationMs && play.msPlayed && play.msPlayed / play.durationMs >= MIN_COMPLETION_RATIO,
  );

  const trackCounts = new Map<string, {title: string; artist: string; count: number}>();
  const artistCounts = new Map<string, number>();

  for (const play of realPlays) {
    const key = `${play.title}::${play.artist}`;
    const existing = trackCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      trackCounts.set(key, {title: play.title, artist: play.artist, count: 1});
    }

    artistCounts.set(play.artist, (artistCounts.get(play.artist) ?? 0) + 1);
  }

  const topTracks = [...trackCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(t => ({title: t.title, artist: t.artist, playCount: t.count}));

  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([artist, playCount]) => ({artist, playCount}));

  return {topArtists, topTracks, realPlayCount: realPlays.length};
}

@injectable()
export default class WrappedService {
  async generate(userId: string, year: number, guildId?: string): Promise<WrappedSummary> {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

    // One row per play this user was actually present for (requester or
    // passive listener alike) -- see PlayHistoryListener's schema comment.
    const listenerRows = await prisma.playHistoryListener.findMany({
      where: {
        userId,
        ...(guildId ? {guildId} : {}),
        playHistory: {
          playedAt: {gte: yearStart, lt: yearEnd},
          msPlayed: {not: null},
        },
      },
      select: {
        playHistory: {
          select: {title: true, artist: true, msPlayed: true, durationMs: true},
        },
      },
    });

    const totalMinutesListened = Math.round(
      listenerRows.reduce((sum, row) => sum + (row.playHistory.msPlayed ?? 0), 0) / 60_000,
    );
    const totalTracksPlayed = listenerRows.length;

    const {topTracks, topArtists, realPlayCount} = rankTracksAndArtists(
      listenerRows.map(row => row.playHistory),
      TOP_N,
    );

    const topGenre = await this.getTopGenre(topArtists.map(a => a.artist));

    const listeningPersonality = this.computePersonality({
      totalTracksPlayed,
      topArtists,
      realPlayRatio: listenerRows.length > 0 ? realPlayCount / listenerRows.length : 0,
    });

    return {
      year,
      guildId: guildId ?? null,
      totalMinutesListened,
      totalTracksPlayed,
      topTracks,
      topArtists,
      topGenre,
      listeningPersonality,
    };
  }

  /** Guild-wide digest since `since` -- top listeners by time, top tracks/artists. */
  async generateGuildDigest(guildId: string, since: Date): Promise<GuildDigestSummary> {
    const listenerRows = await prisma.playHistoryListener.findMany({
      where: {
        guildId,
        playHistory: {playedAt: {gte: since}, msPlayed: {not: null}},
      },
      select: {
        userId: true,
        playHistory: {
          select: {title: true, artist: true, msPlayed: true, durationMs: true},
        },
      },
    });

    const totalMinutesListened = Math.round(
      listenerRows.reduce((sum, row) => sum + (row.playHistory.msPlayed ?? 0), 0) / 60_000,
    );

    const listenerTotals = new Map<string, {msPlayed: number; trackCount: number}>();
    for (const row of listenerRows) {
      const entry = listenerTotals.get(row.userId) ?? {msPlayed: 0, trackCount: 0};
      entry.msPlayed += row.playHistory.msPlayed ?? 0;
      entry.trackCount += 1;
      listenerTotals.set(row.userId, entry);
    }

    const topListeners = [...listenerTotals.entries()]
      .sort((a, b) => b[1].msPlayed - a[1].msPlayed)
      .slice(0, TOP_N)
      .map(([userId, stats]) => ({
        userId,
        minutesListened: Math.round(stats.msPlayed / 60_000),
        trackCount: stats.trackCount,
      }));

    const {topTracks, topArtists} = rankTracksAndArtists(listenerRows.map(row => row.playHistory), TOP_N);

    return {
      guildId,
      since,
      totalMinutesListened,
      totalTracksPlayed: listenerRows.length,
      topListeners,
      topTracks,
      topArtists,
    };
  }

  private async getTopGenre(topArtistNames: string[]): Promise<string | null> {
    if (topArtistNames.length === 0) {
      return null;
    }

    const cached = await prisma.artistGenreCache.findMany({
      where: {artist: {in: topArtistNames}},
    });

    const genreCounts = new Map<string, number>();
    for (const entry of cached) {
      for (const genre of entry.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
      }
    }

    if (genreCounts.size === 0) {
      return null;
    }

    return [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  private computePersonality(input: {
    totalTracksPlayed: number;
    topArtists: Array<{artist: string; playCount: number}>;
    realPlayRatio: number;
  }): string {
    const topArtistShare = input.topArtists[0]
      ? input.topArtists[0].playCount / Math.max(input.totalTracksPlayed, 1)
      : 0;

    if (topArtistShare > 0.4) {
      return `Devoted listener -- over 40% of your plays were ${input.topArtists[0].artist}.`;
    }

    if (input.realPlayRatio < 0.5) {
      return 'The Skipper -- you queue a lot, but rarely let a track finish.';
    }

    if (input.totalTracksPlayed > 500) {
      return 'Heavy rotation -- your queue basically never stopped this year.';
    }

    return 'Eclectic explorer -- a healthy, varied mix all year.';
  }
}
