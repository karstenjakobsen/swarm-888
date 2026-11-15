BUILD PROMPT: VPS AI OPERATOR — DEVELOPMENT MVP

Build a working, self-hosted AI operator for a Linux VPS. Implement the application, run appropriate checks, and document how to run it in development mode. Deliver working software, not just a plan or a UI mockup.

PRODUCT GOAL

A single administrator gives an AI agent goals through a web UI. The agent executes work on the VPS with real host root access, retains durable memory across sessions, and can autonomously create, install, use, and improve its own skills.

The platform owns continuity: conversations, tasks, memory, skills, and execution records. Start with Codex as the agent runtime, behind an adapter so another runtime could be added later. The agent can build and operate arbitrary applications within the machine's actual capabilities and available credentials.

SCOPE

Target one Ubuntu/Debian VPS, one trusted administrator, and one active host-changing run at a time. Multiple conversations may exist; serialize execution through one durable queue.

Support development mode from a source checkout. Do not build release archives, OS installers, package repositories, automatic application updates, production hosting, or a deployment pipeline. Systemd installation is out of scope. Do not require Docker or Kubernetes to run the platform. Applications the agent creates may use containers when appropriate.

Keep the implementation small and understandable. Avoid multi-tenancy, billing, remote worker fleets, skill marketplaces, a full IDE, and a separate vector database.

TECHNICAL DEFAULTS

- TypeScript, latest supported Node.js LTS version, and a committed dependency lockfile.
- Fastify backend; React and Vite frontend.
- SQLite with migrations, foreign keys, WAL mode, and FTS5. Use a maintained SQLite binding compatible with the selected Node version.
- Ordinary files for skill packages, workspaces, and larger artifacts.
- HTTP commands and server-sent events for browser updates; authenticate both.
- A small agent adapter around a pinned, tested Codex CLI/app-server version.
- Validate public inputs and internal protocol messages with shared schemas.
- Makefile

If an existing repository supplies suitable conventions, follow them. Otherwise use these defaults. Inspect the environment and official runtime documentation before choosing exact versions. Make reasonable implementation decisions without repeatedly asking for confirmation.

ARCHITECTURE AND PRIVILEGES

Separate the web controller from a root-capable local worker:

1. The controller serves the API, manages authentication, owns SQLite, handles the queue, and provides the memory and skill services. Run it as the normal development user.
2. A separately launched worker runs Codex and its host tools with the privileges of the worker process. Document the explicit privileged launch command for VPS root mode. Do not run the web controller or frontend dev server as root.
3. Connect controller and worker using a permission-restricted Unix socket with authenticated/validated messages. The worker must have no public TCP listener. Treat access to this socket as root-equivalent.
4. Clearly display the worker's actual execution identity. If it is not UID 0, show non-root mode; never claim host root access. A non-root mode is useful for local development and tests, but real root mode must work on a VPS.

Full root execution is an intentional feature. Do not add command allowlists or routine per-command approval gates. Use the runtime's documented unrestricted execution and approval settings, and verify their effective behavior. If host or runtime policy prevents a request, report it accurately.

The separation above reduces exposure and clarifies ownership. A host-root agent can still modify the platform and its local data; do not describe local controls as an isolation boundary against root.

CODEX INTEGRATION

Use Codex app-server's structured local protocol, preferably over stdio. Verify the actual schema for the pinned binary; generate types where supported. Do not scrape the interactive terminal UI, invent protocol methods, or replace the agent with a simple model-response loop.

Implement initialization, runtime health/authentication status, thread creation and resumption, turns, streamed messages and execution activity, user clarification requests, interruption, and completion/error handling. Persist the relationship between application conversations and runtime thread IDs. Retain the runtime's native session files in persistent storage too.

Provide one working, documented authentication route for model access using the current supported Codex configuration. Keep credentials server-side and out of browser storage and event logs. Missing credentials must produce a useful setup status, not a simulated success. Do not overwrite an unrelated existing Codex profile.

Expose the application's memory and skill operations as real model-callable tools using a supported integration, such as a local stdio MCP bridge. Verify the whole path: the model calls the tool, the application performs the operation, and the result returns to the same turn. Do not count tool instructions in a prompt as an implemented integration.

Keep runtime-specific types inside the adapter. Preserve application memory, skill packages, and task records independently of Codex. Native conversation portability to other runtimes is not required.

TASKS AND EVENT HISTORY

- Persist conversations, messages, queued runs, runtime identifiers, and ordered execution events.
- Represent queued, running, waiting for user input, completed, failed, and interrupted states explicitly.
- Closing or refreshing the browser must not cancel work. Reconnecting must load history and catch up without duplicate displayed events.
- Persist events before broadcasting them. Use sequence IDs/cursors for replay and deduplication. Batch high-frequency text deltas if needed while preserving ordering.
- Handle the gap between controller and worker: use run IDs for idempotent submission, acknowledgements, and a bounded durable worker event journal/outbox for reconnects.
- Reconcile persisted active runs with the worker on reconnect/startup. Reattach to surviving runs when supported. Clearly mark lost or uncertain runs; never blindly repeat a shell action after a crash. Resolve owned orphan execution before admitting another host-changing run.
- Interruption must reach the runtime and report the observed outcome. Make clear which deployed or deliberately detached services continue independently of a task.
- Keep applications built by the agent independent of the browser and agent process lifecycle. A full application deployment dashboard is not required.

DURABLE BRAIN

Use an absolute, configurable APP_STATE_DIR outside source/build output. Default to a per-user persistent directory for development, such as ~/.local/share/vps-ai-operator. Support /var/lib/vps-agent on a VPS. Validate ownership and permissions for the split controller/worker setup. Never put important state in /tmp or a directory cleaned by builds.

Store SQLite data, runtime sessions, skill packages, workspaces, and artifacts beneath this state directory. Reinstalling dependencies or rebuilding the frontend must preserve all of it. Keep secrets separate from searchable memory.

Give the agent flexible memory entries with stable IDs, freeform content, optional categories/tags, project scope, links, source/provenance, timestamps, and revision history. Allow the agent to create, update, link, consolidate, and supersede entries. Distinguish user-provided facts, observations, and agent inferences. Machine observations should retain when they were checked.

Implement real tools for memory search, get, write/update, link, and supersede/archive. Start with SQLite FTS5 and metadata filtering; keep indexes synchronized. Semantic embeddings are out of scope for the first version.

At each new session, inject a compact bootstrap containing purpose, standing owner instructions, active-work summaries, the memory access procedure, and a small skill catalogue. Load detailed memories and skill bodies on demand. Apply context budgets so growing memory does not flood every request. Retrieved content must retain its source and must not silently become an owner instruction.

Provide a way for the agent to record concise progress checkpoints during meaningful milestones and maintain a resumable task summary. Persist actual updates as they happen; do not rely solely on a final summary. This is accumulated knowledge and procedural improvement; model-weight training is out of scope.

AUTONOMOUS, DURABLE SKILLS

Skills are application-owned packages on disk. Use SKILL.md with name/description metadata and concise instructions, plus optional scripts, references, and assets. Store version/activation metadata and usage outcomes in SQLite. Keep the package contents as the authoritative skill source; search indexes are derived.

Implement a skill lifecycle available to the agent through tools:

- Search/list/read existing skills.
- Create a candidate or revise an existing skill in a staging directory.
- Validate metadata, package structure, declared files, and applicable executable helpers.
- Run representative checks using temporary fixtures, recording actual evidence.
- Publish a version atomically and activate it for subsequent runs.
- Disable, retire, or roll back to a previous version.

Track candidate, validated, active, and disabled/retired states. Preserve old versions. Keep the active revision pointer consistent with the filesystem and recover interrupted publication. Updates must not overwrite the version being used by an active run; use immutable version paths or a per-run snapshot.

Make installation real: register the active package with the pinned runtime's supported skill discovery mechanism, refresh discovery where necessary, and verify that a new session can discover and invoke it. Avoid implementing a marketplace/plugin system just to load local skills.

Autonomous activation is allowed after validation; routine skill changes do not require owner approval. Keep checks in the skill manager explicit and observable. Metadata checks alone are not proof that a procedure works. Record representative task results, later corrections, and which skill versions were actually loaded. Use available runtime usage data for time/token metrics; do not invent measurements or causal attribution.

Ship a small foundational skill that teaches the agent how to create, evaluate, install, maintain, and retire skills using the actual tools. Seed it once and preserve agent modifications across app restarts. Search existing skills before making duplicates. Keep machine-specific values in memory or parameters.

Add a bounded, configurable improvement pass after useful completed work. It can identify a reusable lesson, update memory, and create or revise a skill when justified. Track it separately from the user's completed run, give it a timeout/turn budget, and prevent recursive improvement loops. Explicit skill-creation requests should work immediately. Improvement quality is assessed through observable later task results.

MINIMUM WEB UI

Build a clean, responsive interface usable on a phone and desktop:

- Administrator login.
- Conversation sidebar with new/resume conversation.
- Chat view with streamed responses and expandable command/tool activity.
- Task status, queue, interrupt control, and clarification replies.
- Memory search and entry/revision inspection, with owner editing of standing instructions.
- Skill list, version/detail view, validation evidence, and enable/disable/rollback controls.
- Basic connection/model-auth status and actual worker privilege status.
- Links to generated artifacts, served through authenticated application routes.

Use real backend state throughout. Clearly show runtime disconnection and operation failures. An editor, interactive terminal emulator, file manager, and elaborate onboarding are not required.

DEVELOPMENT ACCESS AND CONFIGURATION

Default all browser-facing development listeners to loopback. Document SSH port forwarding for use from a laptop. Proxy API/event requests through Vite for a simple same-origin setup. Do not automatically expose a public root-capable control plane or change the host firewall.

Require an administrator credential from server-side configuration, with no hardcoded default. Use authenticated server-side sessions and HttpOnly/SameSite cookies; use Secure cookies under HTTPS. Protect mutating requests and streams appropriately, validate origins, and avoid rendering untrusted model output as executable HTML. Redact credentials from logs. Document that filesystem paths in host tools are intentionally broad while web artifact routes must validate their allowed roots.

Provide .env.example, documented prerequisites, database initialization/migration, and clear development commands. Ideally the normal-user frontend/controller start through one command and the privileged worker through a separate explicit command. Do not require global installation or system services. Pin dependencies and runtime compatibility; fail with useful diagnostics when a required executable, SQLite capability, socket, or credential is unavailable.

Provide consistent snapshot/export and restore commands for SQLite, skill packages, and native runtime sessions. A simple maintenance window that pauses/drains work and memory/skill writes is acceptable. Use SQLite's backup facilities rather than copying a live database file blindly. Document restoration onto a fresh checkout and permissions needed for the worker. Backup storage configuration and scheduled backups are out of scope.

ACCEPTANCE CHECKS

Use automated tests for durable state, queue transitions, event replay/deduplication, authenticated routes/IPC, memory search/revisions, and skill activation/rollback. Include a minimal browser smoke test. Unit-test runtime protocol handling with recorded fixtures or a test double, while keeping the production path real.

Demonstrate these end-to-end behaviors where the execution environment permits:

1. Start the development processes, authenticate, and connect to the real Codex runtime.
2. Ask the agent to inspect the machine and create a harmless file in a designated test workspace. Display real commands, outputs, and the file result. Verify UID 0 explicitly when claiming root mode.
3. Disconnect/reconnect the browser during a run and recover ordered history without canceling the task.
4. Remember a unique fact, start a fresh conversation, and retrieve it through the memory tools. Repeat after restarting the application.
5. Have the agent create a small useful skill with a deterministic helper, such as generating a report from fixture data. Validate and install it through the skill tools.
6. Start a new conversation with a different fixture and actually discover/use that installed skill. Verify its output independently.
7. Publish a second skill version, confirm the first remains available, and demonstrate rollback. Verify skills and activation survive a restart.
8. Queue two runs and verify only one executes at a time. Exercise interruption and disconnected-worker recovery without silently repeating side effects.
9. Export the durable brain and restore into a fresh state directory; retrieve the remembered fact and use the restored skill.

Use temporary fixtures for checks and avoid modifying unrelated host services merely to demonstrate root capability. If live model credentials or privileges are unavailable, complete everything independently testable, provide exact remaining smoke-test commands, and state the limitation honestly. Never report a test double as a live agent run or claim tests passed without running them.

IMPLEMENTATION AND DELIVERY

Start with a short implementation plan, then build a thin working vertical slice: authenticated browser request -> controller -> worker -> real Codex execution -> persisted events -> browser. Add memory and skills to that working path. Carry the implementation through the acceptance checks; avoid placeholder endpoints and critical-path TODOs.

Include source, migrations, bootstrap instructions/skill, configuration example, useful tests, and a concise README with exact VPS dev startup, model authentication, SSH tunnel, root-worker, troubleshooting, and backup/restore instructions. State verified runtime/Node versions and material limitations. Finish with what works, what was tested, and exactly how to start it.

OFFICIAL REFERENCES TO VERIFY DURING IMPLEMENTATION

Codex app-server protocol:
https://developers.openai.com/codex/app-server
https://learn.chatgpt.com/docs/app-server

Codex skills and discovery:
https://developers.openai.com/codex/skills/
https://learn.chatgpt.com/docs/build-skills

SQLite full-text search, WAL, and backup:
https://www.sqlite.org/fts5.html
https://www.sqlite.org/wal.html
https://www.sqlite.org/backup.html

Use current official documentation and the installed binary's generated schema. Treat experimental APIs explicitly and keep any required experimental support contained in the adapter. Do not assume examples from another CLI version are compatible.
