-- AlterTable
ALTER TABLE "Setting" ADD COLUMN "statsDigestEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Setting" ADD COLUMN "statsDigestCadenceDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Setting" ADD COLUMN "statsWebhookUrl" TEXT;
ALTER TABLE "Setting" ADD COLUMN "statsDigestDmOwner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Setting" ADD COLUMN "statsDigestLastSentAt" TIMESTAMP(3);
