-- CreateEnum
CREATE TYPE "CleanupMode" AS ENUM ('NONE', 'DJ_ONLY', 'ALL_BOT_MESSAGES');

-- AlterTable
-- ADD COLUMN ... DEFAULT backfills existing rows with the default value,
-- so every existing guild's Setting row ends up with cleanup disabled (NONE).
ALTER TABLE "Setting" ADD COLUMN "cleanupMode" "CleanupMode" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Setting" ADD COLUMN "ephemeralDelaySeconds" INTEGER NOT NULL DEFAULT 45;
ALTER TABLE "Setting" ADD COLUMN "cleanupOnSessionEnd" BOOLEAN NOT NULL DEFAULT true;
