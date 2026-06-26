// Mirrors src/utils/get-guild-settings.ts (used throughout the codebase,
// e.g. in add-query-to-queue.ts) but for DJ-specific config. Keeping it
// as a separate model/helper rather than extending Setting so the DJ
// feature stays cleanly removable.

import {PrismaClient, DjSetting} from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULTS: Omit<DjSetting, 'guildId' | 'createdAt' | 'updatedAt'> = {
  enabled: false,
  commentaryEnabled: true,
  commentaryFrequency: 1,
  voiceId: null,
  persona: 'hype',
  minQueueSize: 2,
};

export async function getDjSettings(guildId: string): Promise<DjSetting> {
  const existing = await prisma.djSetting.findUnique({where: {guildId}});

  if (existing) {
    return existing;
  }

  // Mirrors getGuildSettings' upsert-on-read pattern.
  return prisma.djSetting.upsert({
    where: {guildId},
    create: {guildId, ...DEFAULTS},
    update: {},
  });
}

export async function updateDjSettings(
  guildId: string,
  data: Partial<Omit<DjSetting, 'guildId' | 'createdAt' | 'updatedAt'>>,
): Promise<DjSetting> {
  return prisma.djSetting.upsert({
    where: {guildId},
    create: {guildId, ...DEFAULTS, ...data},
    update: data,
  });
}
