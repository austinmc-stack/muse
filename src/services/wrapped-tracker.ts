// Tracks actual listened duration for Wrapped stats. Separate from
// DjRecommender.recordPlay() (which just logs "this track was played,
// here's the metadata" at track START for recommendation purposes) —
// this one needs to know how long a track ACTUALLY played, which is
// only knowable when it ends or is skipped.
//
// Design: instead of writing a row at start then updating it at end
// (two writes, and a race if the process restarts mid-track), this
// writes the PlayHistory row INSIDE DjRecommender.recordPlay() at
// start (msPlayed left null), then this service does a single UPDATE
// when the track stops, setting msPlayed. If the bot crashes mid-track,
// you're left with one row with msPlayed=null rather than missing or
// duplicate data — acceptable for stats purposes, and easy to filter
// out in WrappedService queries (WHERE msPlayed IS NOT NULL).

import {injectable} from 'inversify';
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

@injectable()
export default class WrappedTracker {
  /**
   * Call this once, right when a track starts playing (alongside the
   * existing DjRecommender.recordPlay() call) — finds the PlayHistory
   * row that call just created and stashes its durationMs so the
   * later "track ended" update has something to compute against.
   * Returns the row's id so the caller doesn't need a second lookup
   * when the track ends.
   */
  async setTrackDuration(guildId: string, youtubeId: string, durationMs: number): Promise<number | null> {
    const row = await prisma.playHistory.findFirst({
      where: {guildId, youtubeId},
      orderBy: {playedAt: 'desc'},
    });

    if (!row) {
      return null;
    }

    await prisma.playHistory.update({
      where: {id: row.id},
      data: {durationMs},
    });

    return row.id;
  }

  /**
   * Call this once, right when a track starts playing (same moment as
   * setTrackDuration) — snapshots who's actually in the voice channel right
   * now, so passive listeners get Wrapped credit too, not just whoever
   * typed the command. See PlayHistoryListener's schema comment for why
   * this is its own table rather than a PlayHistory column.
   */
  async recordListeners(playHistoryId: number, guildId: string, requesterId: string | null, listenerUserIds: string[]): Promise<void> {
    if (listenerUserIds.length === 0) {
      return;
    }

    try {
      await prisma.playHistoryListener.createMany({
        data: listenerUserIds.map(userId => ({
          playHistoryId,
          guildId,
          userId,
          role: userId === requesterId ? 'REQUESTER' : 'LISTENER',
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      // Same reasoning as recordListenedDuration below -- stats bookkeeping
      // must never interrupt playback.
      console.warn('[Wrapped] failed to record listeners:', error);
    }
  }

  /**
   * Call this when a track stops playing, however it stops (natural
   * end, skip, disconnect) — records actual listened time.
   */
  async recordListenedDuration(playHistoryId: number, msPlayed: number): Promise<void> {
    try {
      await prisma.playHistory.update({
        where: {id: playHistoryId},
        data: {msPlayed: Math.max(0, Math.round(msPlayed))},
      });
    } catch (error) {
      // Row may not exist (e.g. DJ auto-pick edge cases) -- don't let
      // stats bookkeeping ever throw and interrupt playback.
      console.warn('[Wrapped] failed to record listened duration:', error);
    }
  }
}
