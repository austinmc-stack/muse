// Updated for VC listener tracking:
//   - requestedBy field renamed to userId throughout
//   - queries now find rows WHERE userId = $userId (covers both requesters
//     AND passive listeners, since both now get their own row with their
//     Discord ID in userId)
//   - wasDjPick filter for requester-only stats is now role != 'listener'
//     (role='requester' OR role='dj' are the intentional queues;
//     role='listener' is passive presence)

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

const MIN_COMPLETION_RATIO = 0.5;

@injectable()
export default class WrappedService {
  async generate(userId: string, year: number, guildId?: string): Promise<WrappedSummary> {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

    // UserId covers all rows for this user -- requester, passive listener, and
    // DJ-auto-queued tracks the user happened to be present for (if wasDjPick
    // and role='listener'). The only rows excluded are wasDjPick=true rows
    // where this user is the 'requester' (there are none -- DJ picks have no
    // human requester, so the requester row has userId=null for those).
    const baseWhere = {
      userId,
      playedAt: {gte: yearStart, lt: yearEnd},
      msPlayed: {not: null},
      ...(guildId ? {guildId} : {}),
    };

    const totals = await prisma.playHistory.aggregate({
      where: baseWhere,
      _sum: {msPlayed: true},
      _count: {id: true},
    });

    const totalMinutesListened = Math.round((totals._sum.msPlayed ?? 0) / 60_000);
    const totalTracksPlayed = totals._count.id;

    const rows = await prisma.playHistory.findMany({
      where: baseWhere,
      select: {title: true, artist: true, msPlayed: true, durationMs: true},
    });

    const realPlays = rows.filter(r =>
      r.durationMs && r.msPlayed && r.msPlayed / r.durationMs >= MIN_COMPLETION_RATIO,
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
      .slice(0, 5)
      .map(t => ({title: t.title, artist: t.artist, playCount: t.count}));

    const topArtists = [...artistCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([artist, playCount]) => ({artist, playCount}));

    const topGenre = await this.getTopGenre(topArtists.map(a => a.artist));

    const listeningPersonality = this.computePersonality({
      totalTracksPlayed,
      topArtists,
      realPlayRatio: rows.length > 0 ? realPlays.length / rows.length : 0,
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
