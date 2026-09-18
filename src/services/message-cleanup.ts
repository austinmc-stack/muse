// Tracks bot messages that are candidates for auto-cleanup (DJ commentary,
// track announcements, and — under ALL_BOT_MESSAGES — other bot messages),
// deletes each one after the guild's configured delay, and sweeps up any
// still-pending ones when a DJ session/queue ends.
//
// ponytail: tracking is in-memory only, so a process restart mid-session
// loses track of already-sent messages (they just don't get cleaned up,
// rather than causing any error). Upgrade to a DB-backed TrackedMessage
// table if that cosmetic gap ever actually matters.

import {Message, VoiceChannel} from 'discord.js';
import {injectable} from 'inversify';
import {getGuildSettings} from '../utils/get-guild-settings.js';

export type CleanupCategory = 'dj' | 'control';

interface TrackedMessage {
  message: Message;
  category: CleanupCategory;
  timer: NodeJS.Timeout;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function categoryEnabled(mode: string, category: CleanupCategory): boolean {
  switch (mode) {
    case 'DJ_ONLY':
      return category === 'dj';
    case 'ALL_BOT_MESSAGES':
      return true;
    default:
      return false;
  }
}

@injectable()
export default class MessageCleanup {
  private readonly byGuild = new Map<string, TrackedMessage[]>();

  /** Send a message and, if the guild's cleanup mode covers `category`, schedule its deletion. */
  async send(channel: VoiceChannel, payload: Parameters<VoiceChannel['send']>[0], category: CleanupCategory): Promise<Message> {
    const message = await channel.send(payload);
    await this.track(message, channel.guild.id, category);
    return message;
  }

  /** Track an already-sent message (e.g. a command's interaction reply) for cleanup. */
  async track(message: Message, guildId: string, category: CleanupCategory): Promise<void> {
    const settings = await getGuildSettings(guildId);
    if (!categoryEnabled(settings.cleanupMode, category)) {
      return;
    }

    const tracked: TrackedMessage = {
      message,
      category,
      timer: setTimeout(() => {
        this.untrack(guildId, tracked);
        void message.delete().catch(() => undefined);
      }, settings.ephemeralDelaySeconds * 1000),
    };

    const list = this.byGuild.get(guildId) ?? [];
    list.push(tracked);
    this.byGuild.set(guildId, list);
  }

  /** Bulk-delete any tracked messages still pending for this guild, respecting cleanupMode. */
  async sweep(guildId: string): Promise<void> {
    const list = this.byGuild.get(guildId);
    if (!list || list.length === 0) {
      return;
    }

    const settings = await getGuildSettings(guildId);
    if (!settings.cleanupOnSessionEnd) {
      return;
    }

    const toDelete = list.filter(tracked => categoryEnabled(settings.cleanupMode, tracked.category));
    for (const tracked of toDelete) {
      clearTimeout(tracked.timer);
      this.untrack(guildId, tracked);
    }

    if (toDelete.length === 0) {
      return;
    }

    const fresh = toDelete.filter(t => Date.now() - t.message.createdTimestamp < FOURTEEN_DAYS_MS);
    const stale = toDelete.filter(t => Date.now() - t.message.createdTimestamp >= FOURTEEN_DAYS_MS);

    // Discord's bulk-delete endpoint requires 2-100 messages; fall back to
    // an individual delete for a lone message (or anything past the 14-day window).
    if (fresh.length >= 2) {
      const channel = fresh[0].message.channel as VoiceChannel;
      await channel.bulkDelete(fresh.map(t => t.message.id)).catch(() => undefined);
    } else {
      stale.push(...fresh);
    }

    await Promise.all(stale.map(async t => t.message.delete().catch(() => undefined)));
  }

  private untrack(guildId: string, tracked: TrackedMessage): void {
    const list = this.byGuild.get(guildId);
    if (!list) {
      return;
    }

    const index = list.indexOf(tracked);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }
}
