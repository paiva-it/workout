# Acceptance checklist

These are implementation tests for Claude Code, not a claim that this handoff ZIP contains a tested application. Tests must check behavior, not merely duplicate implementation statements.

## Content and import

- [ ] `node scripts/validate-pack.mjs data/training-pack.v1.json` passes; validate the JSON Schema with the app's validator too.
- [ ] All eight plans, 21 exercises, 20 video references and both programs appear from MongoDB, not a React constant.
- [ ] Week 1 creates two scheduled full-body sessions, one working set per included exercise and RIR 4-5. Week 2 allows three sessions with the same one-set cap. Weeks 3-4 cap at two and use RIR 3-4. Optional work remains omitted.
- [ ] First two focus weeks cap sets at two and RIR 3-4; third focus week offers listed volume with RIR 2-3 without auto-enabling optional work. Item-specific easier notes (light squat, row) remain visible.
- [ ] Same pack/version/same canonical content is a no-op. Same pack/version/different content is 409. A valid higher version is activated only after full validation. A broken reference makes the entire import fail before activation.
- [ ] Importing a new plan without a code change makes it appear in Plans; creating a new version does not change a previous or active session snapshot.
- [ ] Video titles/movement matches are checked; test at least one embed per plan and preserve direct-link fallbacks. Record any unreachable videos honestly.

## Authentication/security

- [ ] Requested credentials log in, wrong password gives generic error, public APIs reveal no personal data.
- [ ] Stored password is Argon2id; plaintext password/hash does not appear in client assets, logs, tracked files or Git history.
- [ ] Bootstrapping twice does not change the password. Password change invalidates other sessions; logout and expired sessions are rejected even before TTL cleanup.
- [ ] Session cookie attributes, CSRF rejection, exact Origin validation, login throttling, user-scoped queries and reverse-proxy client IP behavior are tested.
- [ ] No registration endpoint, publicly bound MongoDB, wildcard credentialed CORS or exposed private files.

## Actual workout logging

- [ ] Log distinct loads/reps on several sets; refresh and restart API; all acknowledged values survive.
- [ ] Same exercise on two dates retains separate sessions and per-set values. Prior-result preview is not counted as new work.
- [ ] Paired 10 kg dumbbells x12 reps means 240 kg-reps; one 10 kg goblet squat x12 means 120. Left/right rows at 10 kg x12 mean 120 per side, 240 combined. Bodyweight push-ups produce no invented external volume. Check supplied fixture expectations.
- [ ] Left/right reps can differ; right-side completion never comes from left-side entry. Working and warm-up sets remain distinct.
- [ ] Pending/zero/blank/skipped are distinguishable. Timed core holds use seconds and do not fabricate rep counts.
- [ ] In-flight duplicate submissions/replays create no duplicate session/set/measurement. Reused operation ID with different payload is rejected.
- [ ] Two tabs editing the same revision cause a visible conflict; one tab cannot silently overwrite the other. Simultaneous starts enforce one active session.
- [ ] Go offline, enter a set, refresh, reconnect: outbox replays once with accurate save status. Logout warns about unsynced data and clears private cache.
- [ ] Pause/resume, mobile backgrounding and reload preserve accurate timing and rest expiry. A partial finish keeps missing work visible. An abandoned session is not counted as completed.
- [ ] Historical corrections require a reason and keep prior values; plan edits preserve history.

## Time and measurements

- [ ] Two same-day weigh-ins both remain stored. 80 kg becomes 80000 grams. `80,5` and `80.5` both become 80500 grams.
- [ ] The imported initial self-report remains date-only; historical remembered PRs remain separate notes, never manufactured training records.
- [ ] Lisbon DST repeated 01:30 on October 25, 2026 preserves both UTC instants/offsets. A session spanning midnight retains its start local date. Changing account timezone does not regroup old local dates.
- [ ] All optional fields may be null without becoming zero. Export includes raw sets, snapshots, weights, dates/timezones and corrections, without auth secrets.

## UI and deployment

- [ ] Browser check at 360px wide and desktop: login, choose plan, log sets, timer, resume, partial finish, view history, weigh-in, import preview/commit and logout.
- [ ] No horizontal overflow; labels and validation accessible by keyboard; all main controls have adequate tap targets.
- [ ] Run typecheck, lint, unit tests, Mongo integration tests and production build. Record commands and actual results.
- [ ] Live HTTPS and cookie login work at training.paiva.it. DB data survives app container recreation. Existing host sites still work.
- [ ] Backup succeeds and isolated restore is actually tested; off-host status is accurately reported.
- [ ] Public repo and built frontend pass secret/private-data scanning. No personal smoke-test data remains publicly exposed.
- [ ] Final report states deployed commit, URLs, operations commands and genuine residual limitations.
