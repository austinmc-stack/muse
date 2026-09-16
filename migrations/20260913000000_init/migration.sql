-- CreateTable
CREATE TABLE "FileCache" (
    "hash" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileCache_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "KeyValueCache" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyValueCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Setting" (
    "guildId" TEXT NOT NULL,
    "playlistLimit" INTEGER NOT NULL DEFAULT 50,
    "secondsToWaitAfterQueueEmpties" INTEGER NOT NULL DEFAULT 30,
    "leaveIfNoListeners" BOOLEAN NOT NULL DEFAULT true,
    "queueAddResponseEphemeral" BOOLEAN NOT NULL DEFAULT false,
    "autoAnnounceNextSong" BOOLEAN NOT NULL DEFAULT false,
    "defaultVolume" INTEGER NOT NULL DEFAULT 100,
    "defaultQueuePageSize" INTEGER NOT NULL DEFAULT 10,
    "turnDownVolumeWhenPeopleSpeak" BOOLEAN NOT NULL DEFAULT false,
    "turnDownVolumeWhenPeopleSpeakTarget" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "FavoriteQuery" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FavoriteQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DjSetting" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minQueueSize" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DjSetting_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "PlayHistory" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "youtubeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "requestedBy" TEXT,
    "wasDjPick" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "playedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "msPlayed" INTEGER,
    "durationMs" INTEGER,

    CONSTRAINT "PlayHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackCooccurrence" (
    "youtubeIdA" TEXT NOT NULL,
    "youtubeIdB" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackCooccurrence_pkey" PRIMARY KEY ("youtubeIdA","youtubeIdB")
);

-- CreateTable
CREATE TABLE "ArtistGenreCache" (
    "artist" TEXT NOT NULL,
    "genres" TEXT[],
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistGenreCache_pkey" PRIMARY KEY ("artist")
);

-- CreateIndex
CREATE UNIQUE INDEX "FavoriteQuery_guildId_name_key" ON "FavoriteQuery"("guildId", "name");

-- CreateIndex
CREATE INDEX "PlayHistory_guildId_playedAt_idx" ON "PlayHistory"("guildId", "playedAt");

-- CreateIndex
CREATE INDEX "PlayHistory_youtubeId_idx" ON "PlayHistory"("youtubeId");

-- CreateIndex
CREATE INDEX "PlayHistory_requestedBy_playedAt_idx" ON "PlayHistory"("requestedBy", "playedAt");

-- CreateIndex
CREATE INDEX "TrackCooccurrence_youtubeIdA_score_idx" ON "TrackCooccurrence"("youtubeIdA", "score");

