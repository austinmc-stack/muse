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
   *
   * `avoidYoutubeIds` is the guild's currently-playing/queued tracks —
   * they haven't hit PlayHistory yet (that's only written once a track
   * actually starts playing), so without this, back-to-back auto-queue
   * calls before those plays land can recommend the same track twice.
   */
  async recommendNext(guildId: string, count: number, avoidYoutubeIds: Iterable<string> = []): Promise<RecommendedTrack[]> {
    const history = await prisma.playHistory.findMany({
      where: {guildId, skipped: false},
      orderBy: {playedAt: 'desc'},
      take: 25,
    });

    if (history.length === 0) {
      throw new Error('no play history yet for this guild');
    }

    const alreadyPlayed = new Set(history.map(h => h.youtubeId));
    // Soft exclusion (on top of alreadyPlayed) so a tiny library that's
    // already fully queued still gets recommendations, just allowing repeats,
    // rather than silently failing to queue anything — see fallback below.
    const excluded = new Set([...alreadyPlayed, ...avoidYoutubeIds]);
    const seeds = history.slice(0, 3);
    const recentArtists = new Set(history.slice(0, 5).map(h => h.artist));

    const candidates = new Map<string, {track: RecommendedTrack; score: number}>();

    // Each seed's queries are independent of the others, so they run in
    // parallel rather than sequentially awaiting one seed at a time.
    await Promise.all(seeds.map(async (seed, i) => {
      const recencyWeight = 1 - (i * 0.25);

      // Collaborative signal: precomputed co-occurrence table, scoped to
      // this guild so other guilds' listening habits never leak in.
      const coocc = await prisma.trackCooccurrence.findMany({
        where: {
          guildId,
          youtubeIdA: seed.youtubeId,
          youtubeIdB: {notIn: [...excluded]},
        },
        orderBy: {score: 'desc'},
        take: 20,
      });

      // We need title/artist for each candidate — pull from the most recent
      // play_history row that references its youtubeId, scoped to this guild
      // (same reason as the cooccurrence query above). Batched into one
      // query for the whole seed instead of one findFirst per coocc row
      // (was up to 20 extra round trips per seed) — `distinct` + `orderBy`
      // guarantees correct most-recent-per-youtubeId results, same pattern
      // as the sameArtist query below. Confirmed empirically (DEBUG=
      // prisma:query against this exact @prisma/client 4.16.0) that this
      // is NOT server-side `DISTINCT ON` pushdown: the generated SQL is a
      // plain `ORDER BY "playedAt" DESC` with no DISTINCT clause at all —
      // the query engine fetches every matching row and dedups itself
      // after the fact. Still one round trip instead of N (strictly better
      // than the old N+1), but a track replayed hundreds of times in a
      // long-lived guild does still transfer every historical row over the
      // wire, it just doesn't get returned to JS. A real fix is either a
      // $queryRaw with `DISTINCT ON`, or upgrading @prisma/client to 5.21.1
      // to match the already-pinned `prisma` CLI — follow-up, not done here.
      const metaRows = coocc.length > 0 ? await prisma.playHistory.findMany({
        where: {guildId, youtubeId: {in: coocc.map(row => row.youtubeIdB)}},
        distinct: ['youtubeId'],
        orderBy: {playedAt: 'desc'},
      }) : [];
      const metaByYoutubeId = new Map(metaRows.map(row => [row.youtubeId, row]));

      for (const row of coocc) {
        const meta = metaByYoutubeId.get(row.youtubeIdB);
        if (!meta) {
          continue;
        }

        addOrBoost(candidates, meta, row.score * WEIGHTS.cooccurrence * recencyWeight);
      }

      // Metadata signal: same artist played before in this guild, excluding already-played.
      const sameArtist = await prisma.playHistory.findMany({
        where: {
          guildId,
          artist: seed.artist,
          youtubeId: {notIn: [...excluded]},
        },
        distinct: ['youtubeId'],
        take: 20,
      });

      for (const meta of sameArtist) {
        addOrBoost(candidates, meta, WEIGHTS.sameArtist * recencyWeight);
      }
    }));

    // Penalize artists that already appeared in the last 5 plays so the
    // DJ doesn't loop one artist forever.
    for (const candidate of candidates.values()) {
      if (recentArtists.has(candidate.track.artist)) {
        candidate.score *= WEIGHTS.recentArtistPenalty;
      }
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      // Co-occurrence and same-artist signals both came up empty. This happens
      // when the most recently played tracks haven't formed co-occurrence pairs
      // yet (e.g. played in a session > 1hr after everything else, so the
      // hour-window never grouped them with anything). Confirmed real case.
      //
      // Fallback: pick randomly from the guild's full play history. Gets
      // smarter automatically as history and co-occurrence data accumulates.
      //
      // Excluding `excluded` (played + currently queued) is ideal, but a small
      // library can run out of unique tracks entirely under that exclusion —
      // in that case, relax it step by step rather than queueing nothing.
      let fallbackPool = await prisma.playHistory.findMany({
        where: {guildId, skipped: false, youtubeId: {notIn: [...excluded]}},
        distinct: ['youtubeId'],
        orderBy: {playedAt: 'desc'},
        take: 50,
      });

      if (fallbackPool.length === 0) {
        // Allow repeating a currently-queued track (not ideal, but better than
        // queueing nothing) — still avoid the track that JUST played.
        fallbackPool = await prisma.playHistory.findMany({
          where: {guildId, skipped: false, youtubeId: {notIn: [...alreadyPlayed]}},
          distinct: ['youtubeId'],
          orderBy: {playedAt: 'desc'},
          take: 50,
        });
      }

      if (fallbackPool.length === 0) {
        // Library is smaller than `alreadyPlayed`'s lookback window — allow
        // any repeat rather than silently failing to auto-queue anything.
        fallbackPool = await prisma.playHistory.findMany({
          where: {guildId, skipped: false},
          distinct: ['youtubeId'],
          orderBy: {playedAt: 'desc'},
          take: 50,
        });
      }

      if (fallbackPool.length === 0) {
        throw new Error('no candidates found and fallback pool is empty — not enough unique tracks in history yet');
      }

      const shuffled = [...fallbackPool].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count).map(row => ({
        youtubeId: row.youtubeId,
        title: row.title,
        artist: row.artist,
      }));
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
