// Run on a schedule from the dj-worker container (see docker-compose.yml).
// For each guild with statsDigestEnabled, checks whether its configured
// cadence has elapsed since the last send and, if so, compiles and
// delivers a digest. Follows the same script style as
// refresh-dj-cooccurrence.ts (run via: npm run env:set-database-url -- tsx src/scripts/send-stats-digest.ts)

import {PrismaClient} from '@prisma/client';
import {REST} from '@discordjs/rest';
import WrappedService from '../services/wrapped-service.js';
import {buildStatsDigestEmbed} from '../utils/build-embed.js';
import {deliverDigest} from '../services/stats-digest-sender.js';

const prisma = new PrismaClient();
const wrappedService = new WrappedService();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function sendDigests(): Promise<void> {
  const guildSettings = await prisma.setting.findMany({where: {statsDigestEnabled: true}});

  const needsDm = guildSettings.some(s => s.statsDigestDmOwner);
  const discordToken = process.env.DISCORD_TOKEN;
  const rest = needsDm && discordToken ? new REST({version: '10'}).setToken(discordToken) : null;

  // Each guild's digest is independent of every other's, so they run in
  // parallel rather than sequentially awaiting one guild at a time.
  const results = await Promise.all(guildSettings.map(async settings => {
    const now = new Date();
    const cadenceMs = settings.statsDigestCadenceDays * ONE_DAY_MS;
    const due = !settings.statsDigestLastSentAt
      || now.getTime() - settings.statsDigestLastSentAt.getTime() >= cadenceMs;

    if (!due) {
      return 'not-due' as const;
    }

    const since = settings.statsDigestLastSentAt ?? new Date(now.getTime() - cadenceMs);
    const summary = await wrappedService.generateGuildDigest(settings.guildId, since);

    let outcome: 'sent' | 'skipped';
    if (summary.totalTracksPlayed > 0) {
      const embed = buildStatsDigestEmbed(summary, `past ${settings.statsDigestCadenceDays} day(s)`);
      await deliverDigest(rest, settings.guildId, embed, {
        webhookUrl: settings.statsWebhookUrl,
        dmOwner: settings.statsDigestDmOwner,
      });
      outcome = 'sent';
    } else {
      outcome = 'skipped';
    }

    await prisma.setting.update({
      where: {guildId: settings.guildId},
      data: {statsDigestLastSentAt: now},
    });

    return outcome;
  }));

  const sent = results.filter(r => r === 'sent').length;
  const skipped = results.filter(r => r === 'skipped').length;

  console.log(`[stats-digest] sent ${sent} digest(s), ${skipped} skipped (nothing to report) of ${guildSettings.length} enabled guild(s)`);
}

sendDigests()
  .catch(error => {
    console.error('[stats-digest] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
