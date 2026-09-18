-- CreateEnum
CREATE TYPE "ListenerRole" AS ENUM ('REQUESTER', 'LISTENER');

-- CreateTable
CREATE TABLE "PlayHistoryListener" (
    "id" SERIAL NOT NULL,
    "playHistoryId" INTEGER NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ListenerRole" NOT NULL,

    CONSTRAINT "PlayHistoryListener_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayHistoryListener_playHistoryId_userId_key" ON "PlayHistoryListener"("playHistoryId", "userId");

-- CreateIndex
CREATE INDEX "PlayHistoryListener_guildId_userId_idx" ON "PlayHistoryListener"("guildId", "userId");

-- AddForeignKey
ALTER TABLE "PlayHistoryListener" ADD CONSTRAINT "PlayHistoryListener_playHistoryId_fkey" FOREIGN KEY ("playHistoryId") REFERENCES "PlayHistory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
