// Run on a schedule (cron, or a setInterval if you'd rather not add an
// extra container). Recomputing co-occurrence on every play would be
// wasteful — this batches it. Follows the same script style as your
// other scripts/*.ts (run via: npm run env:set-database-url -- tsx src/scripts/refresh-dj-cooccurrence.ts)

import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

const ONE_HOUR_MS = 60 * 60 * 1000;

async function refresh(): Promise<void> {
  // SQLite doesn't support the same window-join SQL as Postgres as
  // cleanly, so this does it in two passes using Prisma's query API
  // rather than a raw multi-join SQL string with date-diff math
  // (which has subtly different syntax between sqlite/postgres).
  const recent = await prisma.playHistory.findMany({
    where: {skipped: false},
    orderBy: {playedAt: 'desc'},
    take: 5000, // cap for memory; tune as your history grows
  });

  // Group by guild, then by hour-bucket, to find tracks played "together."
  const byGuild = new Map<string, typeof recent>();
  for (const row of recent) {
    const list = byGuild.get(row.guildId) ?? [];
    list.push(row);
    byGuild.set(row.guildId, list);
  }

  const pairScores = new Map<string, {a: string; b: string; count: number}>();

  for (const rows of byGuild.values()) {
    const sorted = [...rows].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const deltaMs = sorted[j].playedAt.getTime() - sorted[i].playedAt.getTime();
        if (deltaMs > ONE_HOUR_MS) {
          break; // sorted ascending, so nothing further in this guild is within range either
        }

        if (sorted[i].youtubeId === sorted[j].youtubeId) {
          continue;
        }

        for (const [a, b] of [[sorted[i].youtubeId, sorted[j].youtubeId], [sorted[j].youtubeId, sorted[i].youtubeId]]) {
          const key = `${a}::${b}`;
          const existing = pairScores.get(key);
          if (existing) {
            existing.count++;
          } else {
            pairScores.set(key, {a, b, count: 1});
          }
        }
      }
    }
  }

  for (const {a, b, count} of pairScores.values()) {
    await prisma.trackCooccurrence.upsert({
      where: {youtubeIdA_youtubeIdB: {youtubeIdA: a, youtubeIdB: b}},
      create: {youtubeIdA: a, youtubeIdB: b, score: count, sampleSize: count},
      update: {score: count, sampleSize: count},
    });
  }

  console.log(`[DJ] cooccurrence refreshed: ${pairScores.size} pairs across ${byGuild.size} guild(s)`);
}

refresh()
  .catch(error => {
    console.error('[DJ] cooccurrence refresh failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
