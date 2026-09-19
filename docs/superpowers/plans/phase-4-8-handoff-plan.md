# Muse Bot — Phase 2 Handoff Plan (Perf, UX, Ops)

Continues numbering from the prior handoff plan (Phase 0-3c). This plan covers 6 new items.

Confirmed scope from clarifying Q&A:
1. Speedups: broad profiling first, prioritize fixes after seeing the numbers
2. DJ message channel: fixed channel wins if set, else falls back to today's current-VC behavior
3. Skip-last-song: auto-queue must trigger immediately, not wait for the 15-min worker loop (bot currently leaves the VC from inactivity before the loop ever fires)

---

## Phase 4 — Performance Profiling (sub-agent: `profiling-agent`)
Est: 3-4 hrs instrumentation + 1-2 hrs analysis

1. Add temporary timing instrumentation (`console.time`/`console.timeEnd` or a small timing wrapper) around: Kokoro TTS generation call, Ollama commentary generation call, DJ candidate-selection DB query (co-occurrence scoring), track search/queue-add path, audio player start latency
2. Run a normal listening session (30-60 min, several DJ cycles) with instrumentation on and capture logs
3. Produce a ranked report: which step(s) dominate perceived latency, and whether it's compute-bound (Ollama/Kokoro on constrained hardware) vs DB-bound (missing index, N+1 query) vs Discord API-bound (rate limits)
4. Remove or feature-flag the instrumentation before merging fixes
5. Do NOT start fixing anything until the report exists — this phase produces a prioritized list, Phase 4b implements it

**Verify:** report clearly ranks top 3 bottlenecks with actual millisecond numbers, not guesses.

## Phase 4b — Apply Top Fixes (sub-agent: `perf-fix-agent`)
Est: depends entirely on Phase 4 findings — do not estimate until report exists

1. Take the top 1-3 items from the Phase 4 report and fix only those (resist scope creep into unrelated refactors)
2. If Ollama/Kokoro latency dominates: consider pre-warming the model, checking whether requests are serialized when they could run in parallel, or checking hardware allocation (CPU/GPU) for those containers
3. If DB queries dominate: check for missing indexes on `PlayHistory`/`TrackCooccurrence` foreign keys and check for N+1 patterns in the candidate-selection loop
4. Re-run the same timing instrumentation from Phase 4 after each fix to confirm measurable improvement, not just "feels faster"

**Verify:** before/after numbers for each applied fix, committed alongside the code change.

---

## Phase 5 — Deploy Speed Investigation (sub-agent: `deploy-agent`)
Est: 2-3 hrs

Current pipeline: code-server (repo + docker socket mounted) → manual `docker compose build && up` in the integrated terminal. Diagnose before changing anything:

1. Time `docker compose build` and `docker compose up` separately to find out which phase is actually slow
2. Inspect the Dockerfile: confirm `COPY package*.json` + `npm ci` happens before `COPY . .` (source last) so dependency layers cache correctly; if source is copied before deps, that's the likely culprit
3. Check whether it's a multi-stage build; if not, that's likely bloating both build time and final image size
4. Check whether Prisma `generate` re-runs on every build without a cache mount, and whether BuildKit is enabled at all (`DOCKER_BUILDKIT=1`)
5. Check container startup: confirm `dist/scripts/start.js` isn't re-running `prisma db push` unconditionally on every restart when the schema hasn't changed

**Verify:** produce a one-line diagnosis ("build step: X seconds, mostly Y" / "startup step: X seconds, mostly Y") before proposing fixes. Likely fixes (multi-stage build, dependency-layer caching, BuildKit cache mounts) get a follow-up sub-task once the diagnosis is confirmed — don't restructure the Dockerfile speculatively.

---

## Phase 6 — DJ Message Destination Config (sub-agent: `messages-agent`, extends Phase 0/1 work)
Est: 3-4 hrs

1. Add `djChannelId` (nullable) to the guild config model from Phase 0
2. Resolution order at send time: `djChannelId` if set → else today's existing current-VC-based resolution (no behavior change for guilds that don't configure it)
3. Add a way to set it: either a slash command option (`/muse-settings dj-channel #channel`) or fold it into the Phase 8 dropdown settings UI below — don't build both, pick one
4. Add a "reset to default" path (clear `djChannelId` back to null) so guilds aren't stuck once they opt in

**Verify:** test in a guild with no config (today's behavior unchanged), then set a fixed channel and confirm DJ messages route there regardless of which VC is active.

---

## Phase 7 — Auto-Queue on Skip-to-Empty (sub-agent: `queue-agent`)
Est: 4-6 hrs — the trickiest item here, cross-container by default

The DJ auto-queue logic currently lives in a separate sibling worker container on a 15-min loop. Triggering it immediately on skip requires it to be callable synchronously from the main bot process, not just on a timer.

1. Extract the worker's core "pick next track(s) and queue them" logic into a shared function/module (e.g. `src/services/dj-autoqueue.ts`) that both the worker's loop AND the main bot process can call directly — avoid standing up network/IPC between containers if the logic can just be imported in-process instead
2. Hook the skip handler: after a skip resolves and the queue is empty, check if DJ is enabled for that guild and call the shared auto-queue function immediately, synchronously, before the bot's inactivity/leave timer can fire
3. Confirm the worker's 15-min loop still exists as a periodic top-up/safety net (don't remove it, it now supplements the on-skip trigger rather than being the only trigger)
4. Handle the race: if the on-skip trigger and the worker's loop somehow overlap for the same guild, make sure they don't both queue tracks at once (simple in-memory lock or a `lastAutoQueuedAt` guard per guild is enough)

**Verify:** enable DJ, queue one track, let it play, skip it → confirm a new track queues immediately and the bot does not leave the VC from inactivity.

---

## Phase 8 — Dropdown-Based Settings UI (sub-agent: `settings-ui-agent`)
Est: 5-7 hrs — depends on Phase 0, 6, and whatever digest/dedup settings already exist

Consolidate the growing pile of settings (cleanup mode, DJ channel, digest cadence/delivery, dedup window if made configurable) into one guided UI instead of scattered slash-command arguments.

1. Single entry command `/muse-settings` opens an embed with a `StringSelectMenu` grouping settings into categories (e.g. "Cleanup", "DJ Channel", "Stats Digest") — this applies **Hick's Law**: fewer top-level choices, drill down instead of one command with a dozen flags
2. Selecting a category shows a second-level select menu or buttons scoped to just that category's options — keeps each screen to a handful of choices (**Miller's Law** — don't show more than ~5-7 options per menu)
3. Confirm changes with an ephemeral response echoing back the new value in plain language ("DJ messages will now be sent to #music-bot") — immediate feedback, not just a silent DB write
4. Apply consistent visual hierarchy across all bot embeds while this agent is already touching them: color-code by state (e.g. green = active/playing, yellow = paused/pending, red = error), most important info first, secondary details in smaller/footer text — this is the general "UI/UX laws in embeds" ask, scoped here since settings screens are the highest-value place to apply it first
5. Keep interactions ephemeral (visible only to the invoking user) so settings fumbling doesn't spam the channel

**Verify:** a guild owner can go from `/muse-settings` to changing DJ channel + cleanup mode + digest delivery target without typing a single command argument by hand.

---

## Suggested Execution Order
1. `profiling-agent` (Phase 4) and `deploy-agent` (Phase 5) in parallel — both are pure diagnosis, no risk of conflicting with feature work
2. `messages-agent` (Phase 6) — extends existing Phase 0/1 schema work
3. `queue-agent` (Phase 7) — independent, but touches the DJ worker so sequence after Phase 6 if the same agent/branch is involved
4. `perf-fix-agent` (Phase 4b) once Phase 4's report exists
5. `settings-ui-agent` (Phase 8) last, since it wraps configs from Phases 0, 6, and the earlier digest/dedup work

## Pre-Deployment Checklist (additions to the prior plan's checklist)
1. Confirm Phase 4b's before/after perf numbers are documented, not just "should be faster"
2. Confirm Phase 5's Dockerfile changes (if any) still produce a working image — rebuild from scratch once to rule out stale-cache false positives
3. Confirm Phase 7's skip-to-empty fix doesn't double-queue tracks under the race condition described above
4. Smoke test `/muse-settings` end-to-end in a non-production guild before rollout
5. Deploy via the code-server + docker-socket pattern (`docker compose build && up`), verify `dj-pepper-muse-1` shows healthy in Portainer post-deploy
