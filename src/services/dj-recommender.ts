// Recommends the next track(s) to auto-queue, based on this guild's own
// play history. Keyed by YouTube video ID since that's the only stable
// identifier SongMetadata/QueuedSong already carries — there's no
// separate Track entity in Muse, so we don't introduce one.
//
// Note on Spotify: Spotify deprecated /recommendations, /audio-features,
// and /related-artists for new apps in Nov 2024, with no public path back.
// SpotifyAPI in this codebase is metadata/catalog conversion only (used by
// GetSongs to resolve Spotify URLs into YouTube searches), so this service
// intentionally does not call SpotifyAPI for recommendations — it can't.

import {injectable} from 'inversify';
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

export interface RecommendedTrack {
  youtubeId: string;
  title: string;
  artist: string;
}

const WEIGHTS = {
  cooccurrence: 1.0,
  sameArtist: 0.6,
  recentArtistPenalty: 0.6,
};

@injectable()
export default class DjRecommender {
  /**
   * Pick `count` next tracks for a guild's auto-queue. Throws if there's
   * no history yet (caller should catch and just skip auto-queueing —
   * see dj-auto-queue.ts).
   */
  async recommendNext(guildId: string, count: number): Promise<RecommendedTrack[]> {
    const history = await prisma.playHistory.findMany({
      where: {guildId, skipped: false},
      orderBy: {playedAt: 'desc'},
      take: 25,
    });

    if (history.length === 0) {
      throw new Error('no play history yet for this guild');
    }

    const alreadyPlayed = new Set(history.map(h => h.youtubeId));
    const seeds = history.slice(0, 3);
    const recentArtists = new Set(history.slice(0, 5).map(h => h.artist));

    const candidates = new Map<string, {track: RecommendedTrack; score: number}>();

    for (const [i, seed] of seeds.entries()) {
      const recencyWeight = 1 - (i * 0.25);

      // Collaborative signal: precomputed co-occurrence table.
      const coocc = await prisma.trackCooccurrence.findMany({
        where: {
          youtubeIdA: seed.youtubeId,
          youtubeIdB: {notIn: [...alreadyPlayed]},
        },
        orderBy: {score: 'desc'},
        take: 20,
      });

      for (const row of coocc) {
        // We need title/artist for the candidate — pull from the most
        // recent play_history row that references this youtubeId.
        const meta = await prisma.playHistory.findFirst({
          where: {youtubeId: row.youtubeIdB},
          orderBy: {playedAt: 'desc'},
        });
        if (!meta) {
          continue;
        }

        addOrBoost(candidates, meta, row.score * WEIGHTS.cooccurrence * recencyWeight);
      }

      // Metadata signal: same artist played before, excluding already-played.
      const sameArtist = await prisma.playHistory.findMany({
        where: {
          artist: seed.artist,
          youtubeId: {notIn: [...alreadyPlayed]},
        },
        distinct: ['youtubeId'],
        take: 20,
      });

      for (const meta of sameArtist) {
        addOrBoost(candidates, meta, WEIGHTS.sameArtist * recencyWeight);
      }
    }

    // Penalize artists that already appeared in the last 5 plays so the
    // DJ doesn't loop one artist forever.
    for (const candidate of candidates.values()) {
      if (recentArtists.has(candidate.track.artist)) {
        candidate.score *= WEIGHTS.recentArtistPenalty;
      }
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      throw new Error('no candidates found — cooccurrence table may be empty or catalog too small');
    }

    return weightedSample(ranked, count).map(c => c.track);
  }

  /** Call after a track starts playing, to build history for future recommendations. */
  async recordPlay(params: {
    guildId: string;
    youtubeId: string;
    title: string;
    artist: string;
    requestedBy: string | null;
    wasDjPick: boolean;
  }): Promise<void> {
    await prisma.playHistory.create({
      data: {
        guildId: params.guildId,
        youtubeId: params.youtubeId,
        title: params.title,
        artist: params.artist,
        requestedBy: params.requestedBy,
        wasDjPick: params.wasDjPick,
      },
    });
  }

  /** Mark the most recent play row for a track/guild as skipped. */
  async markSkipped(guildId: string, youtubeId: string): Promise<void> {
    const row = await prisma.playHistory.findFirst({
      where: {guildId, youtubeId},
      orderBy: {playedAt: 'desc'},
    });

    if (row) {
      await prisma.playHistory.update({
        where: {id: row.id},
        data: {skipped: true},
      });
    }
  }
}

function addOrBoost(
  map: Map<string, {track: RecommendedTrack; score: number}>,
  meta: {youtubeId: string; title: string; artist: string},
  score: number,
): void {
  const existing = map.get(meta.youtubeId);
  if (existing) {
    existing.score += score;
  } else {
    map.set(meta.youtubeId, {
      track: {youtubeId: meta.youtubeId, title: meta.title, artist: meta.artist},
      score,
    });
  }
}

/** Weighted random sample without replacement, biased toward higher scores. */
function weightedSample<T extends {score: number}>(ranked: T[], count: number): T[] {
  const pool = ranked.slice(0, Math.max(count * 4, 12));
  const picked: T[] = [];

  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.score, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].score;
      if (r <= 0) {
        break;
      }
    }

    picked.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0]);
  }

  return picked;
}
