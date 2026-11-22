# Operator implementation slices

Projects, connectors, and skills belong to registered Git repositories under `APP_PROJECTS_DIR/repositories/`, with required remote URLs and automatic local commits. Deployments, credentials, databases, dependencies, and logs remain outside source Git. Operator workers author assigned package folders; the operator core remains owner-maintained by prompt. New repositories use main with automatic remote publishing; existing registrations retain their settings until explicitly switched.

## Local usability: main and autonomous workflows

- [x] New repositories use one origin URL and main for checkout, fetch and automatic publication.
- [x] Repository UI removes separate branch/destination inputs; one persistent publishing toggle and visible publishing failures remain.
- [x] Explicit Use main conversion preserves existing checkouts, local commits and remote history; incompatible history and active work block conversion.
- [ ] Automatically discover/test connections after registration, source updates and successful credential setup, then resume waiting work.
- [ ] Distinguish optional unavailable connections from required task dependencies so setup/repair tasks can run.
- [ ] Persist project autonomy defaults and reuse/start the local user worker without repeated setup.
- [ ] Verify a complete local workflow: one request creates a project, connection and recurring report; one credential form resumes execution; subsequent runs and restart require no manual enable/test/assign steps.

Verified on 2026-11-22: production build/typecheck passed; full backend regression run passed 394 tests with one optional authentication test skipped; the final added package, publication and conversion API cases passed separately; all 66 browser tests passed. Git publication tests used disposable local remotes. Live provider authentication and an autonomous model-driven workflow remain acceptance work for the next slice.

The following sections describe earlier delivery stages; their local-only Git restrictions predate the main publishing workflow above.

## Repository-backed packages v1

- [x] Repository registry and local create/clone flows with required remote URL, explicit branch/default-branch handling and an `operator/work` branch. No push operation.
- [x] Strict `operator-package.json` v1 with canonical UUID, project/connector/skill kind, semantic package version and kind-specific metadata; skills retain matching `SKILL.md`.
- [x] Bounded committed-manifest discovery, preview, selected import, explicit remote-update fetch, and adoption of folders without executing package commands.
- [x] SQLite repositories/packages/import journal; schema/package/commit versions tracked independently, interrupted attempts recorded, repeat imports idempotent, failed batches preserve last success, canonical moves and cross-repository ID conflicts handled.
- [x] Project, connector and skill authoring flows require registered source; model-callable repository tools and existing source tools work with selected repositories/folders and make local commits.
- [x] Durable repository writing leases span task execution and source finalization; different repositories can progress concurrently, same-repository projects serialize.
- [x] Immutable Git snapshots support binary assets/executable files independently of editor limits. Runtime checks/build/deploy remain separate from import.
- [x] Explicit legacy source migration preserves UUID, runtime directories, service records, conversations and old Git history.
- [x] Repositories UI with create/clone/adopt/discover/import, exact versions, import history, local changes/ahead state, registration notices and package links; source migration and required repository selectors.
- [x] Final corrective regressions, complete checks and requirement-by-requirement delivery audit.

Verified on 2026-11-18 with **343 passing backend tests and 53 passing browser tests**. The optional network device sign-in test was skipped. Type-check, the production build and `git diff HEAD --check` passed. The repository has no separate lint script.

| Requirement | Implementation and evidence |
| --- | --- |
| Required Git remote; work stays local | `src/packages/service.ts` registration, dedicated checkouts, local commits and local-ref status; `packages`, `package-integration` and real browser workflows. No push command/action was added or run. |
| Canonical v1 package config | Strict `operator-package.json`, UUID/kind/semantic version and kind rules, UTF-8/64 KB bound; all three package kinds created and imported in real temporary Git repositories. |
| Monorepo discovery/import/adoption | Committed-object preview, select/import, explicit fetch, default branches, safe folder adoption and root packages; duplicate/fork/move/conflict, stale-write, binary and collision regressions. Import never starts package commands. |
| SQLite outcome and version history | Migrations 010–012, independent format/release/commit versions, interrupted and failed attempts, idempotency and preservation of last successful imports; mixed invalid batches update no selected packages. |
| Reuse existing application workflows | Project source editor/build/deploy, connector registration/test and skill candidate validation/publication use imported source. Skill rename preserves immutable history; old-candidate validation cannot rewrite newer source; unsupported skill files produce explicit notices. |
| Automatic source persistence and recovery | Repository leases plus generic per-package finalization cover projects and skill authoring, multiple packages per task, restart/idempotent recovery, failed commits, independent repositories and atomic journal/lease release; nine dedicated `package-finalization` tests. |
| Existing installation migration | Explicit legacy migration preserves identity, runtime data, service/components and conversations. Root-created source files under external project roots return to controller ownership without following links. |
| UI usable for local testing | Desktop and phone browser coverage for repository registration, preview, import, adoption, version history, source selection, migration, and editor save conflicts. |

Package release builds use only files inside that package's folder. Shared monorepo root build inputs require making the package self-contained. Runtime skill candidates retain their existing complete-text bundle limits and require representative checks before publication. Real provider operations, paid model inference and live systemd deployment were not performed; these remain host/application acceptance work. All implementation acceptance used local disposable repositories and configured remotes without pushes.

## Delivered platform expansion: worker pools and repeatable applications

The objective is the complete reusable platform needed to later build applications such as the discussed cTrader analysis bot through the operator. Provider-specific trading code and real financial actions remain future project work.

- [x] Registered multiple workers with separate sockets, journals, native profiles and authentication; startup-selected model/effort; launching OS user by default and explicit optional root.
- [x] Durable per-worker task attempts, replay/receipt ownership, uncertainty recovery, concurrent independent projects, project write leases through source finalization, and scoped conversation threads.
- [x] Workers UI, registration/start commands, authentication/readiness/draining, manual task assignment, project defaults and visible model/usage/block reasons.
- [x] Model dropdown from the worker's public Codex catalog, safe offline cache fallback, model-specific reasoning effort options, and loading/retry handling without losing the registration draft.
- [x] Confirmed conversation removal from the workspace, with active/related task-tree, in-flight tool, source-finalization and lease guards; durable recovery/job history retained, hidden from future model context, and stale-response/cross-tab UI handling.
- [x] Bounded parent/child delegation through operator tools, project/connection/privilege scope inheritance, recorded results and task cancellation.
- [x] Durable interval/cron/event jobs with deduplicated triggers, pause/resume/run-once/history, chosen worker and execution limits.
- [x] Credential-aware connections with backend-held write-only secrets, selected HTTP/header/stdio injection, generic OAuth authorization/refresh/reconnection, redaction and durable waiting for missing connections.
- [x] Owner-scoped credential references for deployed project services, secret-free launch descriptors and redacted service output; job-specific machine-event credentials for collectors without administrator sessions.
- [x] Git-backed reusable skill authoring connected to the existing validation and immutable publication lifecycle.
- [x] UI/API local fixture acceptance covering creation, credential setup, scheduled small-model-worker analysis, results, restart recovery, and existing regression flows. Model inference is simulated; Git and credential-bound local MCP calls are real.
- [x] Documentation and a requirement-by-requirement completion audit against actual implementation and tests.

## Delivered foundation: slices 1–4

- [x] **1. Source and runtime boundaries** — portable package manifests, separate source/runtime references, existing-project compatibility, and explicit generated-source authoring instructions.
- [x] **2. Automatic Git persistence** — controller-owned managed worktree, serialized scoped commits, task/revision provenance, and visible commit failures without disturbing the owner's checkout or index.
- [x] **3. Build and deploy project revisions** — validate/build committed code, deploy to stable external runtime directories, observe independent services and logs, and display source/deployed revisions in Projects.
- [x] **4. Pluggable MCP connections** — register local packages and remote HTTP endpoints, discover and call namespaced tools, select enabled connections for project tasks, and test through the UI.
- [x] **Automated acceptance** — a local fixture connector and a simple project demonstrate registration, source commits, deployment, MCP calls, and failure handling. Backend, type/build, and browser checks pass. Systemd tests use a simulated host.
- [ ] **Host acceptance** — restart the controller and chosen workers; test user-mode model authentication and manual/delegated/recurring tasks; use Connections → Create local example → Test connection → echo. With an explicit root worker on a systemd host, create a managed service, commit an edit, deploy, inspect logs/status, and stop it.

## Delivered expansion slices

- [x] **5. Credentials and connection setup** — dedicated credential forms, backend-held secrets, authentication health, OAuth refresh, scoped service injection, and durable tasks awaiting a connection.
- [x] **6. Git-backed reusable skills** — committed authoring source connected to validated immutable skill publication.
- [x] **7. Creation and recurring workflows** — model-callable project/source/connector/skill tools, scoped delegation and durable jobs compose the creation/deployment workflow. Confirmed source and effects persist independently; uncertain effects require reconciliation rather than replay or automatic rollback.
- [x] **8. Execution lifecycle and recovery** — per-worker attempts/cursors/receipts, scoped native threads, project leases through commit finalization, recovery visibility and revision redeployment. Broader host discovery and controls for adopted services remain optional future features.

## Delivery decisions

- Registered Git repositories and isolated operator branches; automatic commits stay local and leave the operator development checkout untouched. The former single-repository `generated/` layout remains available for explicit migration.
- Project/package identity and source paths are portable so packages can move into separate repositories later.
- Existing adopted projects retain their runtime paths. Source management is added explicitly.
- MCP connections support local stdio and remote HTTP, with explicit owner-managed credential grants. A provider-specific connector remains ordinary generated package code.
- A stronger build worker and a smaller analysis worker are roles chosen by configuration; model IDs/effort are validated against the pinned runtime. Automatic cost estimation/routing and hard billing caps are not included.
- Continuous data collection/aggregation belongs in project services; interval/cron/event jobs admit bounded analysis tasks. Model tools cannot broaden the accepted project's connections, root permission, or task budgets.
- Test scenarios are local fixtures; no DigitalOcean, certificate, broker, or trading operations are included.

## Verification and handoff

Verified on 2026-11-16:

- Latest verification including conversation removal: 292 unit/integration tests passed, one optional live-auth test skipped; TypeScript and production build passed; all 47 browser tests passed. No separate lint task is configured; `git diff --check` passed. Checks reported no warnings.
- Browser verification uses the Chromium installed in `/tmp/vps-operator-browsers`: `env -u NO_COLOR PLAYWRIGHT_BROWSERS_PATH=/tmp/vps-operator-browsers npm run test:browser`. Latest evidence: `/tmp/operator-conversation-delete-backend.log`, `/tmp/operator-conversation-delete-browser.log`, and `/tmp/operator-conversation-delete-build.log`. Browser tests used disposable localhost servers and temporary Git/state directories.
- Real temporary Git repositories verify automatic scoped commits, preserving owner HEAD/index/staged/unstaged changes, immutable exports, known-credential rejection, and restart-safe source finalization.
- Real stdio and local HTTP MCP fixtures verify initialization, discovery, calls, response limits, cleanup, and failed requests. The actual pinned Codex app-server discovers and calls a dynamically registered tool without receiving controller/model/bridge credentials in its connector subprocess.
- Desktop and phone browser checks cover source edits/commits, distinct deployed revisions, deployment/log/stop controls, connector registration/testing/calls, project assignments, and stale/offline status.
- Persistent systemd installation/enabling/restart/stop, literal command arguments, checked builds, and repeat-deploy idempotency use injected host/service-manager fixtures. No real host service was installed or changed during implementation.
- A live authenticated model deployment and live root/systemd service remain host acceptance work. Critical build/MCP crash recovery has been brought forward; uncertain operations are not automatically replayed.

## Platform completion audit

| Requirement | Implementation and verification |
| --- | --- |
| Multiple workers and model selection | `src/workers`, private per-worker state/launch manifests, live/cache model catalog and Workers dropdown; `workers-runtime`, `worker-launch`, `platform`, `model-catalog`, `worker-models-api` and browser tests |
| Durable ownership and concurrent projects | Store attempts/project leases and Queue replay/dispatch; `platform`, `platform-policy`, `runtime-receipts`, crash recovery and queue lifecycle tests |
| Bounded delegation | TaskService and run-bound platform tools, frozen connection grants, privilege/budget/tree limits; `platform-policy` and `scenario-platform` |
| Recurring analysis and collector events | JobService interval/cron/event schedules, restart-safe deduplication and job-only bearer ingress; `platform`, `job-events`, `scenario-platform`, Jobs browser flows |
| Backend credentials and OAuth | Encrypted vault, owner grants, credential-bound MCP proxy and callback/refresh handling; `credentials`, actual pinned app-server MCP tests and Connections browser flows |
| Long-running project services | References-only runtime environment, private service launch descriptor and redacting supervisor; `project-environment` tests and runtime credential browser flows |
| Reusable skills in Git | Managed source commits and revision-pinned immutable publication; `skill-source` and existing skill lifecycle tests |
| Existing installation upgrade | Five-migration legacy database upgraded and reopened with history/receipts/replay preserved and per-worker concurrency retained; `platform` upgrade regression |
| Conversation cleanup | Migration 009, workspace visibility/context filtering, related-work/tool/finalization/lease guards, durable replay and job deduplication; `conversation-deletion`, `conversation-deletion-api` and six desktop/phone browser regressions |
| End-to-end reusable scenario | Real controller persistence, temporary Git/checks, local authenticated MCP, selected simulated small-model worker, results/usage, delegation and restart; `scenario-platform` plus browser UI coverage |

Provider app registration, account authorization, market-data semantics, signal quality, trading/risk rules and live deployment are future project acceptance, not claims made by these generic fixtures. Native MCP token expiry during a running session and service credential changes require the application's next snapshot/restart. Source protection remains prompt-only. The old snapshot CLI rejects expanded layouts; use the documented complete stopped-state backup.

## Review and corrective work

Additional worker-platform review on 2026-11-16:

- [x] **P1: follow-up authority** — automatic improvement tasks use the same frozen connection, privilege, context/output, tool/time and tree limits as delegation. Optional scheduling failures do not invalidate a completed task. Requested root settings stay immutable for idempotent retries; accepted attempt UID supplies legacy root capability.
- [x] **P1: project creation ownership** — linking a running generic conversation to its newly created project acquires its lease atomically. Other tasks wait through source finalization. Conflicting links and failed project creation roll back without leaving registrations behind.
- [x] **P1: configured-secret ingress** — administrator, IPC and configured environment secrets join the vault's common input guard and event redactor. Task/job/metadata/instruction inputs reject known values before persistence; explicit login and write-only credential routes remain supported.
- [x] **P2: scheduler availability and semantics** — rare/impossible timezone cron schedules search matching calendar dates instead of millions of minutes. Stepped day wildcards follow cron day matching; malformed numeric steps reject. Tests cover daylight-saving gaps/repeated hours, leap days, non-hour offsets and bounded formatter work.
- [x] **P2: predictable task admission** — manual, delegated and fully rendered job/event prompts must fit their context budget before creating history. Improvement summaries are bounded to their inherited capacity or skipped safely. Job connection inheritance resets work through model tools while preserving the parent grant.
- [x] **P2: credential/source boundary** — portable connector manifests cannot carry authorization configuration; snapshots use owner metadata only. Clearing/replacing bindings revokes obsolete exact-connector grants and pending authorization exchanges. The former manifest mismatch failed closed at revision checks; no secret-injection bypass was demonstrated.
- [x] **P2: parallel registration** — simultaneous connector registrations merge against the current accepted grant, preserving both additions instead of overwriting one with an earlier snapshot.
- [x] **P2: immutable skill provenance** — published-version validation rejects before any Git write; per-skill create/validate/publish ordering preserves the current authoring revision and published source mappings.
- [x] **P2: honest UI readiness/history** — App and Workers share readiness rules for uncertainty, outstanding receipts, authentication and replacement. Manual/event trigger keys have readable history labels instead of invalid dates; model worker status includes replay errors.
- [x] **Boundaries and cleanup** — database decoding and nested transactions live in persistence helpers; model task/job policy lives outside HTTP registration; worker IDs reuse one schema. Removed unused exports/imports and duplicate redaction logic without changing legacy API field names.

- [x] **Boundaries** — transport schemas are pure shared DTOs, independent of subprocess/network clients; source and connector services use typed persistence stores and validate worker responses.
- [x] **API consistency** — shared transport/command/result limits, explicit package-kind conflicts, exact deployment revision/directory/unit checks, and consistent project refresh from UI/tools.
- [x] **Source correctness** — stale editor commits return 409; rejected writes preflight secrets, paths, sizes and structural conflicts before mutation; source creation is idempotent; only the intended package is committed.
- [x] **Concurrent observations** — older service observations cannot overwrite a newer deployment; changed connectors invalidate tests; late tests cannot re-enable or verify changed connections.
- [x] **UI correctness** — preserve drafts and commit messages, lock pending editor operations, guard navigation, synchronize project assignments, reject stale results, and display MCP tool errors.
- [x] **Runtime lifecycle** — status/logs remain responsive during builds, transitional services can be stopped, duplicate close is safe, and subprocess cleanup checks captured process ownership.
- [x] **P1 brought forward with owner approval** — worker operation journal and gated supervisor launch; durable PID/start/boot capture before execution; no new effects after restart uncertainty; ownership-safe multi-process reconciliation; explicit external-effect acknowledgement; no replay or rollback of provider/service actions.
- [x] **Receipt gap** — confirmed external outcomes persist in the controller before worker acknowledgement; lost ACK recovery sends only ACK, never the original action; authenticated bounded receipt inspection is available.
- [x] **Adversarial verification** — real temporary worker SIGKILL during local helpers, stdio and HTTP; failed identity capture cannot execute code; independent processes survive reconciliation; missing/reused identities fail closed; completed-result receipt recovery does not repeat mutations.
- [x] **Project-root configuration drift** — worker health advertises its projects directory; runtime requests reject root mismatches before effects; connected root workers expose fresh restart commands in the UI. `npm run worker:root` captures normal-user configuration before sudo. Verified idle worker replacement checks process identity and reserves execution; busy or uncertain workers stay running. Existing project paths and source commits are preserved.
- [x] **Obsolete project removal** — owner-confirmed registry cleanup works offline for missing or outside-root directories, removes project-owned connections and assignments, and preserves conversations, files, Git history, runtime receipts, and running services. Pending work and in-flight resource operations block removal.
- [x] **Verified-kill cleanup race** — after SIGKILL, cleanup waits for group disappearance without sending another signal after its leader has exited. Persistent survivors still require inspection; timeout errors remain predictable during normal teardown.
- [x] **Pool-wide project removal guard** — unresolved execution on any observed worker blocks unregister, including a standalone uncertain connector operation on a secondary worker. Offline registry cleanup still makes no worker calls.
- [x] **Independent receipt recovery** — unavailable or changed-journal owners do not prevent exact-owner ACK recovery for healthy workers. Remaining failures are reported after all pending receipts have been attempted; effects are never repeated.

The managed Git lock remains deliberately fail-closed after a controller dies while holding it. Verify no source operation is running before the documented lock cleanup; no automatic lock stealing is implemented. No real root service/provider operation was performed by the test suite.

See README.md → Managed source, deployments and MCP connections for package contracts and the UI test steps.
