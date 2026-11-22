# V1 implementation plan

**Build toward two task pages and one skill revision.** From the approved UI, an owner asks about a Docker fixture. The operator creates the missing skill and uses it in that task. After a worker restart, a fresh conversation uses the same Git revision on different fixtures. The milestone passes when both task pages show independently graded results and the skill page links to the later verification.

The V1 checkout began with [PROMPT.md](PROMPT.md). The approved design checkout at `/home/karsten/projects/github/karstenjakobsen/self-learning-vps-operator-design` was clean at `af0bb8cc4299ddc02c5a609323797fec205ab750` during planning. Recheck at import. Deliver slices 1–4 through the UI, show the checkpoint below, then continue through slices 5–9.

**V1 serves one owner, one operator and one host.** Use real Docker in WSL2 for learning and recovery, one loopback MCP read tool for credentials, and one test-owned file for defense. Include VPS systemd units and private-access instructions. Keep DNS/TLS examples in the fixture demo. Live DNS, DigitalOcean integration, TLS issuance, Nomad installation and host-wide hardening are outside V1. Fleet coordination, peer trust and GPU workers belong to V2.

## First milestone — learn and reuse one skill

### 1. Import the approved UI and establish its baseline

- [x] Imported the clean design checkout at `af0bb8cc4299ddc02c5a609323797fec205ab750` into [web/](web/) in local commit `412278b257f20a6376f0a6d52aa09493294ec864`. All 52 tracked files were copied, with zero local source changes included. The imported subtree and source tree share Git tree ID `df57fc0bc1b0cb7a77788386a0d2f3363aaf4cfa`.
- [x] Installed with the frozen lockfile and `pnpm@12.3.4` on WSL2. The Next.js production build and separate TypeScript check passed. Playwright exercised the production copy at 1440 × 900 and 390 × 844. At both widths the Morning brief loaded, the composer created a task, its answer and evidence survived reload, and Inspect linked to memory, projects, connectors and skill revisions. The DNS/TLS task displayed the fixture's DNS and certificate observations.
- [x] Exercised the placeholder credential dialog at both widths. It offered no value-entry field and posted only the fixture request ID. The backup task resumed. After a 14-second simulated disconnect, each run caught up and matched a full replay of 120 events. The demo uses the [operator store](web/components/operator/store.tsx) for UI actions and subscriptions, the [Next.js API handlers](web/app/api) for commands, events and demo credentials, the [fixture log](web/lib/operator/server-log.ts) for ordered events and the [projection](web/lib/operator/project.ts) for replay.

To run the verified production copy locally, use Node.js 24 with Corepack. The locked frontend packages supply the IBM Plex fonts.

```sh
cd web
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm exec tsc --noEmit
corepack pnpm run start --hostname 127.0.0.1 --port 3000
```

### 2. Carry one owner message through the live system

- [x] Added the root Makefile, locked uv environment, Ruff, pytest, generated API type check and a Next.js production build that enforces TypeScript checks. `make check-fresh` runs `make setup` then `make check` in a new local clone.
- [x] FastAPI journals an authenticated owner message and queued task together in migrated SQLite, then wakes the worker over a mode-0600 Unix socket. The worker records pickup, acknowledgment and completion. The operator profile, owner instructions, messages, checkpoints, session hashes and ordered events survive process restarts in the external state directory.
- [x] The approved screens use a snapshot, command and event interface selected on the server. In live mode Caddy serves one loopback origin and routes API requests directly to FastAPI. Each task displays the outcome computed in Python.
- [x] The API test covers a message committed between snapshot and subscription, then resumes with `Last-Event-ID` and compares every event and the terminal outcome with a fresh snapshot. It also checks a lost worker notification, a running checkpoint and idempotent submission.
- [x] The 390 × 844 Playwright walkthrough queues a message, takes the controller offline, reopens the task and checks the unavailable state. The worker picks up the task, and after the controller returns the original page resumes after event 2. The task timeline agrees with a full reload and the brief shows the same acknowledgment. The private-origin test rejects anonymous reads, writes and streams, and rejects a cross-origin authenticated mutation. A separate demo walkthrough exercises replay, the placeholder credential and the DNS/TLS fixture.

See [the WSL2 startup and test commands](README.md). The worker's acknowledgment establishes delivery through the live system. Model execution and skill tools start in slice 3.

### 3. Create and invoke the first revision through local MCP

- [ ] Ship a versioned foundational authoring skill and its working template with the framework. Provide a documented `make catalog-init` entry point taking the external remote, branch, checkout and state directory. On a fresh installation, initialize the empty catalog with `skills/`, `connectors/` and `projects/`, commit and push the bundled seed and template, and activate the seeded authoring revision. Record the seed version and catalog commit. A second initialization must preserve the catalog and active revisions.
- [ ] Run that public setup against a fresh state directory and temporary empty bare remote. Assert discovery lists only the foundational skill and a Docker inspection search returns no match. The seed teaches discovery, definition of inputs and observable success, composition, testing and evidence recording. Acceptance uses the same setup as an owner installation.
- [ ] Implement discovery, scaffolding, testing, activation and invocation as stable local MCP tools. Freeze a candidate at a Git commit, run its self-tests against those contents and atomically select that revision on success. Launch helpers as separate processes, resolve the revision once at dispatch, refresh named tools on the running server, and retain a stable invocation tool for clients with cached discovery.
- [ ] Drive those tools through a typed worker adapter for Codex app-server over stdio with start, resume, steer and interrupt. Use a deterministic model double through the same interface in CI. Persist the building task, revision, tests, activation, invocation arguments and results separately so a revision's evidence can be opened from the UI.
- [ ] **Pass when** a newly activated named tool becomes discoverable and callable in the same task without restarting the worker. Take that path directly into the Docker walkthrough.

### 4. Prove Docker learning and reuse through the UI

- [ ] Add `make acceptance-docker` and document fixture image preparation. Have the runner call the slice 3 initializer with a fresh state directory and empty remote, then assert the initial discovery result. As the WSL2 developer, check `docker context show` and `docker info` before creating fixtures. Give Docker access to the worker and runner. The runner owns setup and cleanup, using a unique per-run label and cleaning only its fixtures even on failure.
- [ ] Submit the exact owner request from [PROMPT.md §4](PROMPT.md#4-prove-the-workflow-using-real-docker) with the selector via the copied UI. Capture the unsuccessful skill search, then the author, test, activate and invoke calls before the original task completes. Put the parameterized, read-only Docker inspection procedure in the generated skill. Keep the grader in the runner.
- [ ] Have the runner query the engine directly. Compare the exact container set, names, images, states and exit codes for exited containers. Cover a running container, a known nonzero exit and an empty selection. Record both the independent observations and the comparison against each task's reported result.
- [ ] Restart the worker against its persisted state. Open a fresh conversation and give it a second labeled fixture set with different names and exit data. Assert the same full Git SHA was invoked without a rewrite. Track **built**, **self-tested**, **activated**, **ran in the creating task** and **verified on a later task** as distinct facts. Only award the last one for a different task and input, the same revision, and independent evidence.
- [ ] **Show the first checkpoint.** Link the creating task page, the reuse task page and their shared skill revision. Print both task IDs and the full Git SHA. The first page shows discovery, creation, tests, activation and the first call. The second shows the different input, the invocation of the same revision after restart and the comparison with Docker. Follow the revision page's link back to the later verification.
- [ ] Record the independent engine observations and model mode for each walkthrough. A passing run driven by the deterministic double is **integration verified with simulated authoring**. Use **autonomous authoring verified** only when the real Codex app-server creates the missing skill and the walkthrough passes. If credentials are missing, record that at handoff with the exact command to rerun the same acceptance path with Codex.

## After the first milestone

### 5. Verify revision changes and recover an interrupted host mutation

- [ ] Immediately after the Docker checkpoint, finish the revision lifecycle tests through public MCP calls. Hold an invocation open, activate a newer revision, then release the call. Assert it finishes on the original SHA while a new invocation uses the new SHA. Submit a broken candidate and assert the active revision stays usable. Implement and exercise rollback via the stable MCP tool, then verify discovery and invocation use the restored revision. Use temporary SQLite state and Git for these cases.
- [ ] Serialize host-changing runs. Before dispatch, persist a stable operation ID, owner authorization, target, intent and pinned revision. Resume decisions on the original task. Treat logs and retrieved memories as evidence only.
- [ ] Authorize starting one stopped fixture. Interrupt the worker after Docker accepts the start and before it records completion. **Pass when** restart reconciles the original operation by inspection, the runner independently observes a running container, and the dispatch count is exactly one. With an unreadable target double, assert a visible unknown outcome, bounded observation attempts and zero repeat writes.

### 6. Complete catalog synchronization, memory and Inspect navigation

- [ ] Test pull, commit and push against the bare remote using two checkouts. On conflicting edits preserve both contributors' work and surface the conflict. Disconnect the remote and invoke the locally retained active revision after restart.
- [ ] Add memory search, read, write, revise and remove through MCP. Store scope, provenance, revision history and task reads/writes. Wire **Ask the operator to correct this** to an owner message referencing the entry. Verify the correction, earlier revision, writer and later readers from both memory and task pages.
- [ ] **Pass when** Inspect shows the credential-stripped catalog remote and branch, with source paths for skills, connectors and projects. Navigate from a project to its tasks and separate application source, and from a task to its exact revision, self-tests and independent verification. New revisions start with their own evidence.

### 7. Connect one authenticated read tool and resume its task

- [ ] Use a loopback remote MCP server, harmless read tool and dummy token. Store endpoint, auth method and secret reference in the catalog. Bind the secret reference to an owner-authorized destination outside it.
- [ ] Pause the task on a missing credential. In private live mode submit the value through an authenticated, write-only browser flow directly to FastAPI. Resume the same task and show discovered tools and actual calls. The task links a connector only after using it.
- [ ] Have the loopback server delay the read beyond the connector timeout. Assert the call ends within its configured bound, the task records a timeout, and the UI shows it without a successful read result. **Pass when** the ordinary authenticated read succeeds, a catalog endpoint change cannot redirect the credential, and the dummy token stays out of Next.js, Git, chat, model context, logs and events in both paths.

### 8. Maintain a standing goal and correct a failing skill

- [ ] Implement conversational goal creation, pause, resume and retirement. Put checks and repairs in versioned skills. The worker owns scheduling, cooldowns, serialized repairs and durable incident attempt/time budgets. Test with a controllable clock.
- [ ] Maintain permissions on a test-owned WSL2 file. Assert zero model calls for healthy checks. Pause the goal, introduce drift and advance the clock past a due check. Assert zero repair dispatches and independently confirm the file still has the altered permissions. Resume the goal, confirm drift before repair, then independently read the restored permissions. On an unknown result, retry observation within budget.
- [ ] Give a failing skill a regression case, run that case and its earlier suite, and activate the corrected revision. **Pass when** the same incident budget survives a restart and revision change, the owner receives one attention notification when needed, and the Morning brief links through the incident, goal and repair revision to the recovery evidence or unknown outcome.

### 9. Restore, deploy privately and hand off the evidence

- [ ] Implement consistent export and restore across SQLite, immutable skill contents and workspaces. Restore into a fresh state directory and open the original tasks, invoke their pinned skill revision and check the saved cursor and incident budget.
- [ ] Document WSL2 foreground startup commands, external catalog configuration and backup/restore commands. Supply opt-in systemd units and SSH forwarding instructions for a Debian or Ubuntu VPS. Support an explicitly configured root worker and report its observed execution identity. Record WSL2 worker restart and Linux VPS reboot as separate acceptance rows. Mark the VPS reboot **unrun** when only WSL2 was available.
- [ ] Run Ruff lint and formatting checks, pytest, frontend typecheck and production build. Run phone-width Playwright against live records from the walkthrough, following task → revision → later reuse and submitting a conversational memory correction.
- [ ] Include the frontend source and import SHAs, included local changes, destination path, commands, and an acceptance table marking each path real, simulated or unrun with its evidence. End the walkthrough with the two Docker task IDs and their shared full skill revision.
