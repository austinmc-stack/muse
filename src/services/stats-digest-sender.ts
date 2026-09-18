// Delivers a compiled stats digest to a guild's configured targets.
// Runs from the dj-worker container (see send-stats-digest.ts), which has no
// Discord gateway connection -- so DM delivery goes through the REST API
// directly (open-DM + send-message calls), the same client bot.ts already
// uses for command registration, rather than spinning up a full
// discord.js Client just to send one message.

import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v10';
import type {EmbedBuilder} from 'discord.js';

export interface DigestDeliveryTargets {
  webhookUrl: string | null;
  dmOwner: boolean;
}

export async function deliverDigest(
  rest: REST | null,
  guildId: string,
  embed: EmbedBuilder,
  targets: DigestDeliveryTargets,
): Promise<void> {
  const payload = {embeds: [embed.toJSON()]};

  if (targets.webhookUrl) {
    try {
      await fetch(targets.webhookUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.warn(`[stats-digest] webhook delivery failed for guild ${guildId}:`, error);
    }
  }

  if (targets.dmOwner && rest) {
    try {
      const guild = await rest.get(Routes.guild(guildId)) as {owner_id: string};
      const dmChannel = await rest.post(Routes.userChannels(), {
        body: {recipient_id: guild.owner_id},
      }) as {id: string};
      await rest.post(Routes.channelMessages(dmChannel.id), {body: payload});
    } catch (error) {
      console.warn(`[stats-digest] owner DM delivery failed for guild ${guildId}:`, error);
    }
  }
}
