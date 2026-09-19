# Task 1 (Phase 4 — profiling-agent) report

**Scope this dispatch:** step 1 only (add instrumentation, deploy, verify, commit).
Steps 2-5 (real listening session + ranked report) are explicitly deferred to a
follow-up dispatch per `task-1-brief.md`'s dispatch-scope note.

## Status: DONE_WITH_CONCERNS

Instrumentation is live and deployed. Needs a real 30-60min listening session
from the operator before the report (steps 2-5) can be written — do not attempt
to simulate this yourself.

## Plan deviation: Kokoro/Ollama call sites don't exist

The brief (and progress.md's conflict scan) name five instrumentation sites,
two of which — "Kokoro TTS generation call" and "Ollama commentary generation
call" — no longer exist in this codebase. Checked `git log` per the
deprecated-vs-never-built lesson before reporting this: commit `40920d7`
("Replace Ollama/Kokoro DJ commentary with a chat announcement") deliberately
removed both `src/services/dj-commentary.ts` and `src/services/dj-tts.ts`,
along with their config/inversify wiring, and replaced DJ auto-queue
announcements with a plain embed. This predates the current session — it's a
real, intentional prior removal, not a "doesn't exist" excuse. There is
nothing left to instrument for those two sites.

Covered the remaining 3 of 5 sites instead:

1. **DJ candidate-selection (co-occurrence scoring)** — `src/services/dj-recommender.ts`'s
   `recommendNext()`, called from `maybeAutoQueue()` in `src/services/player.ts`.
2. **Track search / queue-add path** — `GetSongs.getSongs()` through the
   `player.add()` loop, in `src/services/add-query-to-queue.ts`'s
   `continueAddToQueue()`.
3. **Audio player start latency** — `getStream()` through
   `playAudioPlayerResource()`, in `playWithAttempt()` in `src/services/player.ts`.

## What was added

Plain `Date.now()` deltas (no new dependency, no wrapper module — one-line
diffs at each site), logged as `console.log(\`[perf] <site>: <ms>ms\`)` so
they're trivial to `grep '\[perf\]'` out of container logs later and to
remove/feature-flag before Phase 4b. Not gated behind `DEBUG` — these need to
print unconditionally so the operator's real session actually captures them
without extra env-var setup.

- `src/services/player.ts`
  - `maybeAutoQueue()`: wraps the `recommendNext()` call in a local
    `try/finally` so the timing logs even when it throws (e.g. "no play
    history yet" / "no candidates found") — those throws are still useful
    signal about how long candidate selection took before giving up.
  - `playWithAttempt()`: wraps `getStream()` → `playAudioPlayerResource()`.
- `src/services/add-query-to-queue.ts`
  - `continueAddToQueue()`: wraps `getSongs.getSongs()` through the
    `newSongs.forEach(... player.add ...)` loop as one span, matching how the
    brief names "track search/queue-add path" as a single item. (`getSongs`
    is the network/yt-dlp-bound part; `player.add` is an in-memory array
    push and expected to be near-zero — bundling them costs nothing and
    avoids inventing a second log line the brief didn't ask for.)

Each site is commented `// Ponytail: Phase 4 profiling instrumentation,
temporary -- see .superpowers/sdd/phase-4-8-handoff-plan/task-1-brief.md` so
whoever does step 4 (remove/feature-flag before merging fixes) can find all
three by grepping for `Ponytail:` or `[perf]`.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint src/services/player.ts src/services/add-query-to-queue.ts` — clean
  (one pre-existing `max-params` warning on `Player`'s constructor, unrelated).
- `npx vitest run` — all 329 tests / 22 files pass, no regressions.
- **No live Discord smoke test was run.** No Discord client is available this
  session, and the brief's own guidance (plus task notes) says not to fabricate
  one. Instead, confirmed the instrumentation actually fires on the real code
  paths (not mocked out) via the existing unit-test harness:
  - `tests/add-query-to-queue.test.ts` → prints `[perf] track-search-and-queue-add: Nms`
  - `tests/player-state.test.ts` (DJ auto-queue tests) → prints
    `[perf] dj-candidate-selection: Nms` (confirmed on both the success path
    and the "no candidates" rejection path, proving the try/finally fires on
    both)
  - `tests/player-state.test.ts` (forward/playback-attempt tests) → prints
    `[perf] audio-player-start: Nms`
- **Deploy verification** (per repo's documented workflow — see memory
  `muse-docker-deploy-workflow.md`, live compose dir bind-mounted to this
  workspace, Compose project `dj-pepper`):
  - `sudo docker compose -p dj-pepper build muse` — built clean (tsc, prisma
    generate, image export all succeeded).
  - `sudo docker compose -p dj-pepper up -d muse` — `dj-pepper-muse-1` and
    `muse-db` came up; `muse-db` was recreated as part of this `up` (not
    explicitly requested — appears to be a pre-existing config-hash/`up`
    behavior unrelated to my change, see Concerns) but its named volume
    persisted: verified `Setting` (2 rows) and `PlayHistory` (72 rows) both
    intact post-recreate via `docker exec muse-db psql`.
  - `docker logs dj-pepper-muse-1` — clean startup: `=== RUNNING DB PUSH ===`
    → `=== DB PUSH DONE, STARTING BOT ===` → Discord gateway connect →
    `✔ Ready!`. No `Error:` blocks.
  - Did not directly capture a `[perf]` line from the live container (that
    needs a real `/play` from Discord, which requires the operator — see
    Concerns below), but the unit-test evidence above confirms the exact same
    code paths, compiled into the same image that's now running, do log.

## Commit

- `499f454` — "Add Phase 4 timing instrumentation for DJ, search, and
  playback-start paths" (matches existing repo convention: prose body +
  `Co-Authored-By` / `Claude-Session` footer, per `git log`).
- Files: `src/services/player.ts`, `src/services/add-query-to-queue.ts`.
- Left `src/index.ts`'s pre-existing uncommitted one-line change
  (`// diag-timestamp ...`) out of the commit — it predates this session and
  isn't related to this task; didn't touch or revert it.
- `docs/` (untracked) also left alone — unrelated to this task.

## Concerns

1. **This is the real ask, not a nit:** the brief's step 2 (30-60min real
   listening session with several DJ cycles) has not happened. Nothing in
   this dispatch can substitute for it — do not treat the unit-test
   `[perf]` lines above as satisfying step 2. The ranked report (steps 3-5)
   cannot be written until real session logs exist.
2. Kokoro/Ollama scope reduction (see above) — flagging explicitly in case
   the handoff plan's author wants those two rows struck from the brief, or
   wants a note added to Phase 4b that those two bottleneck categories are
   moot.
3. `muse-db` got recreated by `docker compose -p dj-pepper up -d muse` even
   though only the `muse` service was targeted. Data was verified intact
   (named volume, not deleted), but per the deploy-workflow memory this
   container is specifically flagged "must never be recreated/renamed" as a
   gotcha — worth the deploy-agent (Task 2 / Phase 5) or the operator
   checking why `up -d muse` touched `db` at all (likely an image/config-hash
   change on `postgres:15-alpine` or a compose-file diff since the container
   was last started, not something this task's edits caused — this task only
   touched two `src/services/*.ts` files).
4. Timing granularity: `recommendNext()` internally runs several DB queries
   per seed in parallel (`Promise.all`) — the single `dj-candidate-selection`
   number is the whole call's wall time, not broken down by individual query.
   If the eventual report needs to distinguish "which specific query" within
   DJ selection, that's a follow-up instrumentation pass, not something to
   add speculatively now.

---

# Steps 2-5: ranked report from the real listening session

**Status: DONE**

A ~45min live Discord listening session with several DJ auto-queue cycles was
run by the operator (not simulated). Captured data:
- `task-1-session-logs.txt` — every `[perf]` line (16 data points: 9
  audio-player-start, 5 dj-candidate-selection, 2 track-search-and-queue-add)
- `task-1-session-full-raw.log` — same window's full container log (in this
  case it contained no additional per-event lines beyond the `[perf]` lines
  themselves and startup boilerplate — no `debug()`-level cache-hit/miss or
  voice-connection detail was present, since `DEBUG` wasn't set for this run;
  noted as a data limitation below, not fabricated).

## Raw data

| site | n | values (ms) |
|---|---|---|
| audio-player-start | 9 | 2919, 119, 2493, 2249, 2628, 2079, 3053, 2684, 2439 |
| dj-candidate-selection | 5 | 182, 127, 199, 131, 221 |
| track-search-and-queue-add | 2 | 149, 122 |

| site | mean | median | min | max |
|---|---|---|---|---|
| audio-player-start (all 9) | 2297ms | 2493ms | 119ms | 3053ms |
| audio-player-start (excl. 119ms outlier, n=8) | 2568ms | 2560ms | 2079ms | 3053ms |
| dj-candidate-selection | 172ms | 182ms | 127ms | 221ms |
| track-search-and-queue-add | 136ms | — | 122ms | 149ms |

## Ranked top 3 bottlenecks

**#1 — `audio-player-start` (avg ~2.3-2.6s, 8 of 9 samples between 2.08s-3.05s) — dominant, by roughly 15-19x the other two sites.**
This is by far what a listener actually perceives as "lag" between a track
being selected (by `/play` or DJ auto-queue) and sound starting. It spans
`getStream()` (checks `FileCacheProvider` first, then on a miss calls
`getYouTubeMediaSource`/`getSoundCloudMediaSource`, which shells out to
`yt-dlp` to resolve a playable stream URL) through `createAudioPlayer` +
`playAudioPlayerResource`. **Root cause: external-process/network-bound on
cold-cache media resolution (yt-dlp), not compute-bound, not DB-bound, not
Discord-API-bound.** No database query and no Discord REST/gateway call sits
inside this span — `voiceConnection.subscribe()` and `createAudioResource()`
are local/synchronous. The strongest evidence for "cache miss is the cost"
is the single 119ms sample sitting ~20x below every other sample in the same
set: per `src/services/player.ts`'s `getStream()`, a cache hit
(`this.fileCache.getEntryFor(cacheHash)` resolves) skips the `yt-dlp`
extraction step entirely and feeds ffmpeg a local file directly — that code
path is the only mechanism in `getStream()` capable of producing a ~20x
speedup, so it's a well-supported inference from source, though the raw log
for this session didn't carry per-line cache-hit/miss tags to confirm it
line-by-line (see Caveats). 8 of 9 samples landing in a tight 2.08-3.05s
band is consistent with "almost every track this session was a fresh
yt-dlp resolution," i.e. the file cache mostly wasn't warm yet.

**#2 — `dj-candidate-selection` (avg ~172ms, range 127-221ms) — DB-bound, real but an order of magnitude below #1.**
`DjRecommender.recommendNext()` (`src/services/dj-recommender.ts`) is a
genuine N+1 query pattern, visible directly in the code, not just inferred
from timing: for each of up to 3 seed tracks (run concurrently via
`Promise.all`), it runs one `trackCooccurrence.findMany` (up to 20 rows),
then fires one more `playHistory.findFirst` **per returned row** (up to 20
more queries per seed) to backfill title/artist, plus one `playHistory
.findMany` for the same-artist signal. That's structurally up to ~63
Postgres round trips per call, all concurrent rather than serial, which is
presumably why the wall-clock cost stays in the low hundreds of ms instead
of scaling linearly — but it's still the textbook "missing an eager-fetch/
join, doing N extra roundtrips" pattern the brief's own language names.
Same-network (`db:5432` in the same Docker Compose network) round-trip
latency plus Postgres query planning under concurrent connections is the
likely explanation for the 127-221ms spread, not a single slow query.

**#3 — `track-search-and-queue-add` (avg ~136ms, only 2 samples) — small, and thin data.**
Spans `GetSongs.getSongs()` (YouTube Data API search / yt-dlp URL resolution
for `/play`) through the in-memory `player.add()` loop. Only 2 data points
because this path is specific to human-issued `/play` calls — DJ auto-queue
additions go straight from `recommendNext()`'s already-known
title/artist/youtubeId to `player.add()` without ever calling `getSongs`, so
a 45-minute session dominated by DJ auto-queue cycles mostly doesn't exercise
this site. At ~120-150ms this is the smallest of the three and not a
priority; the YouTube Data API call inside `getSongs` is the likely cost
(external-API-bound, not DB- or Discord-bound), but with n=2 that's a
plausibility note, not a finding to act on.

**Not measured / can't rank:** the brief's fourth category, "Discord API-bound
(rate limits)," was not directly instrumented anywhere (no timer around
`interaction.reply`/`editReply`, voice-connection establishment, or gateway
round trips). Nothing in the 3 instrumented spans touches a Discord REST or
gateway call, so none of the top-3 bottlenecks are Discord-API-bound — but
this doesn't rule out Discord API latency mattering *outside* these 3 spans
(e.g. the `/play` interaction's own defer/reply latency). Flagging as an
open question rather than guessing a number for it.

## Recommendation for Phase 4b (prioritization only, no fixes made here)

1. **`audio-player-start` is the only site worth spending Phase 4b's budget
   on first** — it dominates perceived latency by well over an order of
   magnitude versus the other two. The direction indicated by this data is
   "increase file-cache hit rate / warm cache more aggressively for
   DJ-likely-to-repeat tracks," since that's the one lever in `getStream()`
   demonstrated (by the 119ms sample) to cut this cost by ~20x. Confirming
   that with cache-hit/miss-tagged logging would be the natural next
   instrumentation step if Phase 4b wants harder confirmation before
   committing to that direction.
2. `dj-candidate-selection`'s N+1 pattern is real and fixable (batch the
   per-row `playHistory.findFirst` calls into one `findMany` with
   `youtubeId: {in: [...]}`), but at ~130-220ms it's not where a listener's
   perceived lag is coming from — worth doing as a low-risk DB cleanup, not
   worth prioritizing over #1.
3. `track-search-and-queue-add` doesn't warrant action from this data —
   small and thin (n=2).

## Caveats on this data

- n=9/5/2 from one session — enough to rank the 3 sites confidently given the
  ~15-19x gap between #1 and #2/#3, but not enough to characterize
  `audio-player-start`'s cache-hit-rate distribution precisely, or to say
  anything statistically meaningful about `track-search-and-queue-add`.
- The cache-hit explanation for the 119ms `audio-player-start` outlier is a
  source-grounded inference (confirmed by reading `getStream()`'s cache-check
  branch), not a directly logged fact for that specific sample — the session
  wasn't run with `DEBUG=muse` so the `debug('Caching video')` /
  `debug('Not caching video')` lines that would have confirmed it per-track
  weren't captured.
- All 9 `audio-player-start` samples came from one guild/session on one
  machine; hardware-constrained yt-dlp/ffmpeg startup cost could vary
  elsewhere.
