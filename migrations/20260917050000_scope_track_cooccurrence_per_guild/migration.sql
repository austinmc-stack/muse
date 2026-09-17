-- Existing rows mix co-occurrence counts across guilds (bug: the refresh
-- script grouped pairs by guild in memory but wrote them into one shared,
-- guild-less table). They can't be un-mixed, and regenerate cleanly on the
-- next refresh-dj-cooccurrence run, so they're discarded here.
TRUNCATE TABLE "TrackCooccurrence";

ALTER TABLE "TrackCooccurrence" DROP CONSTRAINT "TrackCooccurrence_pkey";
DROP INDEX "TrackCooccurrence_youtubeIdA_score_idx";

ALTER TABLE "TrackCooccurrence" ADD COLUMN "guildId" TEXT NOT NULL;
ALTER TABLE "TrackCooccurrence" ADD CONSTRAINT "TrackCooccurrence_pkey" PRIMARY KEY ("guildId", "youtubeIdA", "youtubeIdB");

CREATE INDEX "TrackCooccurrence_guildId_youtubeIdA_score_idx" ON "TrackCooccurrence"("guildId", "youtubeIdA", "score");
