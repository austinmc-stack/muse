import {Setting} from '@prisma/client';
import {prisma} from './db.js';

export async function createGuildSettings(guildId: string): Promise<Setting> {
  return prisma.setting.upsert({
    where: {
      guildId,
    },
    create: {
      guildId,
    },
    update: {},
  });
}

export async function getGuildSettings(guildId: string): Promise<Setting> {
  const config = await prisma.setting.findUnique({where: {guildId}});
  if (!config) {
    return createGuildSettings(guildId);
  }

  return config;
}
