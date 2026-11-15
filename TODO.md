# VPS AI Operator — implementation slices

Build a working development MVP from `PROMPT.md`. Complete the thin execution path first, then extend the same durable services. Check items only after implementation and verification; record unavailable live checks honestly.

## 1. Foundation and protocol contract
- [x] Inspect Node/runtime availability and official Codex documentation; pin compatible versions and generate the installed app-server protocol schema.
- [x] Create the TypeScript/Fastify/React/Vite project, lockfile, shared input schemas, Makefile, and configuration example.
- [x] Establish an absolute persistent state directory, ownership/permission checks, SQLite migrations, WAL, foreign keys, and FTS5.

## 2. Authenticated execution vertical slice
- [x] Implement administrator login, server-side cookie sessions, origin/CSRF checks, authenticated API and SSE.
- [x] Implement authenticated, validated Unix-socket controller/worker messaging with actual worker UID and runtime/auth health.
- [x] Connect a real Codex app-server adapter: initialize, create/resume thread, start turn, stream activity, clarify, interrupt, finish/fail.
- [x] Persist conversations, messages, runs, thread IDs, and ordered events before broadcasting; render the execution path in the browser.

## 3. Durable queue and recovery
- [x] Serialize all execution through a persisted queue with explicit queued/running/waiting/completed/failed/interrupted states.
- [x] Add idempotent run submission, acknowledgement, bounded worker outbox, cursor replay, and reconnect deduplication.
- [x] Reconcile active runs on reconnect/restart; block new work while an owned orphan is unresolved and never retry uncertain side effects.
- [x] Propagate interruption and clarification replies to the runtime and show observed results.

## 4. Durable memory and model-callable tools
- [x] Implement FTS5 memory search/get/write/update/link/supersede/archive with provenance, timestamps, metadata, and revision history.
- [x] Implement standing owner instructions, bounded session bootstrap, checkpoints, and resumable task summaries.
- [x] Expose real memory and skill operations through an authenticated local stdio MCP bridge registered with Codex.
- [x] Verify the real app-server → stdio MCP → authenticated controller → SQLite → native tool response round trip (without a model).

## 5. Versioned autonomous skills
- [x] Implement on-disk candidates, package validation, deterministic fixture checks and persisted evidence.
- [x] Publish immutable versions atomically; activate, disable/retire, roll back, and recover interrupted publication.
- [x] Register active packages through supported Codex discovery; record loaded versions and outcomes.
- [x] Seed a foundational skill once and preserve subsequent changes.
- [x] Add a separate, bounded, non-recursive improvement run after useful completed work.

## 6. Complete web interface
- [x] Build responsive login, conversation sidebar, streaming chat, expandable execution activity, queue/status, interrupt and clarification controls.
- [x] Add memory search/revisions and editable standing instructions.
- [x] Add skill details/versions/evidence and enable/disable/rollback controls.
- [x] Show controller/worker/model authentication health, actual execution identity, failures, and authenticated artifact links.

## 7. Backup, acceptance checks, and delivery
- [x] Implement maintenance-window snapshot/export and fresh-directory restore using SQLite backup facilities.
- [x] Test durable state, queue transitions/recovery, replay, authentication/IPC, runtime protocol handling, memory, and skill lifecycle.
- [x] Run a minimal browser smoke test and all available live Codex/worker checks.
- [x] Document exact development, model authentication, root-worker, SSH tunnel, backup/restore, troubleshooting, verified versions, and remaining limitations.

## Verification record

### Browser agent connection and root-only execution update

- [x] Add authenticated, CSRF-protected browser connection/status/cancel controls backed by the pinned app-server's real ChatGPT device-login protocol.
- [x] Keep pending login in the worker across browser/controller reconnects; expire/cancel/retry without putting credentials or codes in task history.
- [x] Enforce actual UID 0 for production worker startup, sign-in and task dispatch, including already authenticated non-root workers.
- [x] Add Start root worker with an exact server-generated privileged launch command when the host requires interactive sudo.
- [x] Reserve idle worker admission before verified replacement; reject active, uncertain, pending-check or authenticating workers.
- [x] Verify the queue waits throughout sign-in, including authentication started during asynchronous preparation, and resumes only after verified connection.
- [x] Run the complete check: **77 automated tests passed, 1 optional native-network test skipped by default, production build passed, and 5 browser tests passed**. The native-network device start/cancel test was also run explicitly against pinned Codex 0.166.0 and passed in isolated test state; it did not authenticate an account or call a model.
- [x] Restart the live UI/controller, stop the old idle non-root worker, and verify the authenticated live root-start API reports the real sudo-password requirement while preserving the queued task.
- [ ] Complete the one-time OS root launch on this host and finish ChatGPT approval through Connect agent. The OS requires the administrator's interactive sudo password; the UI shows the exact command. No UID 0 execution or completed account sign-in is claimed yet.

Verified on 2026-11-15 with Node 26.13.1, npm 11.16.0 and pinned Codex 0.166.0.

- Full `npm run check` passed: 39 automated tests, TypeScript/production build, and 2 real desktop/phone browser checks.
- Subsequent paged-journal/reconnect regressions passed in the affected suites, including actual Unix-socket recovery of a backlog larger than 16 MiB. Final coverage: **42 passing backend/runtime tests and 2 passing browser tests**, verified across these runs; final TypeScript check also passed.
- Actual Codex initialization, missing-authentication status, effective unrestricted thread settings, native skill discovery and native app-server/MCP application-tool round trip passed.
- Real deterministic skill helper execution, immutable versions/rollback, restarts, snapshot/restore, orphan process resolution, and authenticated SSE replay passed.
- This host lacks libatomic; verification used a library unpacked under `/tmp/vps-operator-libs` through `LD_LIBRARY_PATH`, without installing host packages. Ordinary VPS prerequisites are documented in README.

### Credential/privilege-dependent live acceptance

These remain unverified in this environment, rather than simulated:

- [ ] Execute a real model turn that inspects the host and writes the designated harmless file; demonstrate UID 0 with an explicitly launched root worker.
- [ ] Have the model initiate memory/skill MCP calls, discover and invoke its newly installed skill in a fresh conversation, and verify outputs.
- [ ] Repeat the model-driven memory and skill checks after application restart and fresh-directory restore.

Run `npm run smoke:live`, then `npm run smoke:live -- --verify-restart` and `npm run smoke:live -- --verify-restore` against an authenticated instance. The script checks real backend events and independent output files, and stops before creating any run when model authentication is missing. Exact setup/root-worker/SSH/backup commands are in README.
