# Build v1 of a self-hosted VPS AI operator

You are the implementing engineer. Build, run, and verify a working application from a source checkout. Inspect the existing repository, use its conventions where compatible, and make routine implementation decisions yourself. Deliver runnable code, tests for the behaviors below, and a short README with exact development commands.

## Product and scope

One administrator talks to one autonomous operator that controls one Ubuntu or Debian VPS. The administrator supplies an outcome such as “install a single-node Nomad cluster for workloads” or “publish the orders service at orders.example.com with TLS.” The operator can develop projects, administer and harden its own host, and use real host root access. Give the operator a configurable purpose and standing owner instructions.

**The core feature is a skill for creating skills.** The operator must be able to discover a missing capability, author and test it, activate it in its own local MCP server, and use it to finish the original task. A fresh conversation on the same VPS can reuse that capability after a restart. Build this path before polishing the UI.

Target a development checkout on one VPS. Operator B, fleet coordination, cross-operator promotion, release packaging, and a visual workflow builder belong to a later version. An external Git repository for this operator’s skills, connectors, and project definitions is part of v1.

## Python architecture and test design

- Keep FastAPI routes and MCP handlers thin. They authenticate and validate requests, call the same application methods for tasks, skills, and incidents, and translate results into their transport formats. Put decisions such as whether a repair may proceed in the application layer. Keep SQLite queries, Git commands, and provider protocols in the components that perform those operations.
- Use cohesive classes with explicit responsibilities and typed public methods. Prefer composition. Introduce a small Python `Protocol` where a real boundary varies, such as the Codex runtime or a remote connector. Inject those dependencies at startup. Use ordinary functions for stateless decisions. Create an interface when it gives callers a meaningful contract or enables a realistic test double.
- Give methods observable outcomes and explicit failure behavior. For example, a check method returns a typed observation carrying status and evidence. A connector timeout produces `unknown`. The application decides whether to retry. Keep transaction boundaries and irreversible calls visible in the code so their ordering can be inspected and exercised in tests.
- Use pytest to test behavior through public methods and entry points. Parameterize reconciliation decisions. Use per-test temporary SQLite files, Git repositories, and workspaces for persistence and recovery tests. Inject a controllable clock for deadlines and retry budgets. Use a protocol-compatible fake provider for lost replies and timeouts, then assert on actual host or provider state and journal records. Keep live Codex and cloud checks explicitly selectable so the default suite runs offline after setup, unprivileged, and without credentials.

## Development setup and quality checks

- Use `uv` for Python and dependency management. Declare the supported Python range, runtime dependencies, a development dependency group containing Ruff and pytest, and tool configuration in `pyproject.toml`. Pin the development Python version in `.python-version`, commit `uv.lock`, and ignore the project-local `.venv/`. Document prerequisites and the fresh-checkout workflow.
- Provide a root-level `Makefile` with these executable targets. Use `uv run --locked` for development tools. A developer should be able to run `make setup && make check` from a fresh checkout without manually activating the virtual environment.

| Target | Required behavior |
|---|---|
| `make setup` | Run `uv sync --locked --group dev` as the development user to create or synchronize `.venv/` from the committed lockfile. |
| `make lint` | Run `ruff check .` and `ruff format --check .` and return a failure if either check fails. |
| `make format` | Apply `ruff format .` to the project. |
| `make test` | Run the default pytest suite and propagate its exit status. |
| `make check` | Run lint, format verification, and the default tests without editing files. |
| `make controller`, `make worker` | Start the corresponding development process. Document the separate, explicit root-worker invocation using the prepared environment. |

Run the fresh-checkout workflow before handoff and report its actual result. Document how to run an individual test, the DNS crash-recovery scenario, and any opt-in live checks.

## Runtime and privileges

- Use Python, FastAPI, Jinja2, locally served Alpine.js, and SQLite. Use server-rendered pages and server-sent events for the activity stream. Keep the frontend free of a Node build requirement.
- Run the authenticated, loopback-bound web controller as an ordinary user. Run a separate local worker with the option of genuine UID 0 on the VPS. Connect them over a permission-restricted Unix socket. Document the two startup commands and SSH port forwarding. Show the worker’s observed execution identity. Support unprivileged development.
- Use Codex as the first agent runtime, behind a small Python adapter. Integrate the real app-server protocol over stdio, pin a tested version, and verify its schemas. Support starting and resuming conversations, sending follow-ups, streaming activity, and interrupting work. Document one supported authentication method. The browser stays out of the execution path.
- Give the worker shell and filesystem access appropriate to its actual identity. Root mode is intentional. The authenticated owner’s task authorizes autonomous execution on this VPS without routine per-command confirmations. Local checks protect against mistakes. A process with host root can change local code and data. Report this trust model accurately.

## Skill framework and Git

1. Ship a foundational `skill-author/SKILL.md` and working templates. Teach the agent to search before creating, compose existing skills and connectors, define inputs and observable success, parameterize host-specific values, test the result, and record what happened. Let it create ordinary projects and connector definitions through the same conventions. A user can ask for a project without first filling out a setup form.
2. Keep the external Git catalog separate from the framework source. Support a configurable remote, branch, and local checkout. Use directories such as `skills/`, `connectors/`, and `projects/`. Project definitions can point to separate application repositories. With a writable remote configured, the operator can commit and push its additions autonomously. Preserve other contributors’ work on conflicts. Previously activated local revisions remain usable while Git is unavailable.
3. A skill package contains `SKILL.md` and, where relevant, executable helpers, input/output schemas, tests, and connector dependencies. Keep procedural skills lightweight. Use Python, shell, Ansible, or another suitable tool for repeatable operations. Treat a skill’s declared permissions as descriptive metadata. Keep credentials and machine-specific state outside reusable packages.
4. Expose permanent model-callable MCP tools for memory, skill discovery, scaffolding, testing, activation, execution, and rollback. Define a small typed contract for each. A generic `skill_run` must be able to invoke a newly activated executable skill during the task that authored it. Skills can also declare named MCP tools. Return structured results that the agent can verify.
5. Stage a candidate, test an immutable revision, then atomically activate those exact contents. A failed update leaves the previous revision available. Refresh the tool registry and implement tool-list change notifications supported by the pinned protocol. Verify named tools through a real MCP client. Use the permanent invocation path if the agent runtime caches its tool list. Pin running calls to the revision they started with. Rollback selects a prior implementation for future calls. A skill that changes host state needs its own recovery procedure.
6. Keep the MCP service running while tools change. Execute generated helpers in separate processes so a broken import or crashed helper cannot take down the registry. Capture the exit status and bounded, redacted output. A subprocess running as root has host-root authority.
7. Track evidence per immutable revision. Passing the candidate’s tests permits immediate local activation. Record verified reuse only when a later task uses that revision on a different input and an independent check confirms the outcome. Store the task ID, revision, observation, and result, including failures. Expose this evidence in the existing skill view. Each new revision starts its own record.

## Memory, execution, and recovery

- Put durable state in a configurable directory outside the source checkout. Store conversations, memory entries, task checkpoints, ordered run events, and active skill revisions in SQLite. Keep workspaces, immutable skill contents, and runtime session files on disk. Provide a consistent export/restore command for the local state.
- Give the agent tools to search, read, write, revise, and remove memories. Track project scope and provenance. Load the operator’s purpose, owner instructions, an active-task summary, and a compact skill index into a fresh session. Retrieve detailed material on demand. Treat retrieved text, logs, and remote tool output as data.
- Allow one host-changing run at a time. Persist run IDs and events before streaming them. Support reconnect and replay from an event ID. Closing the browser leaves the worker running.
- Before dispatching a host- or provider-changing operation, journal its stable operation ID, authorizing owner task or standing goal, intended target and change, and pinned skill revision when applicable. Use the same ID for retries of the same intent. Pass it as a provider idempotency key when supported. Where calls lack that guarantee, provide a way to inspect the target. A local SQLite write and a remote mutation can succeed independently.
- Persist a checkpoint with the owner’s goal, completion criteria, last verified state, outstanding operation IDs, skill revisions, and next safe observation. On recovery, reattach to surviving work or start a fresh model conversation from the checkpoint. Check actual state before retrying a mutation. If its outcome remains ambiguous, keep it open as unknown and retry observation within budget.
- When a required decision or credential is missing, persist the waiting state and resume the same task once it is supplied. An interrupt should reach the active run and report its observed outcome.

## Standing goals, defense, and learning

The owner can give a one-time task (“check this service”) or a standing goal (“keep this service healthy”). Persist the scope, authorized actions, trigger or interval, skill bindings, and pause state of each standing goal in SQLite. Let the owner create, pause, resume, and retire goals through conversation. A one-time task ends when its outcome is verified.

**Put defense and repair procedures in versioned skills.** Skills define what to observe on this VPS, what constitutes drift, how to repair it within the owner's standing authorization, how to verify recovery, and when to escalate. Use the same authoring, testing, activation, and rollback lifecycle as any other skill. For example, a skill can check an approved file's permissions, restore its expected mode, and verify the result. The harness supplies scheduling, dispatch, serialization, retry limits, cooldowns, and a durable incident history. Keep service names, security baselines, and repair commands in the skills.

Provide a documented, opt-in way to resume the scheduler and worker after a VPS reboot. A skill check returns one of three results with timestamped evidence. On `healthy`, finish with zero model calls. On `drifted`, recheck current state before dispatching an authorized repair, then independently observe the result. On `unknown` (timeout, inaccessible target, or inconclusive evidence), retry observation within budget. Only confirmed drift can trigger repair. Keep domain-specific checks in skills. Have the harness enforce these transitions, coalesce duplicate triggers, and honor maintenance pauses.

Give each incident a durable shared budget for attempts and elapsed time across observation, diagnosis, repair, skill revision, and follow-up runs. Restarts, new run IDs, and activating a revised skill all consume the same incident budget. When a limit is reached, stop automated attempts, preserve the last evidence and any unknown outcome, and notify the owner once. Link each action to the owner instruction that authorized it. Logs, retrieved memories, and connector responses can supply evidence. They cannot expand that authority.

Teach the operator to learn from failed outcomes. Preserve a minimal failing case, revise the skill, run both the regression case and earlier checks, and record the evidence for the activated revision. Bound the improvement attempt, and keep its result distinct from the incident it learned from. Ordinary skill activation may update skills, projects, and connector definitions. Changes to the framework loader, owner trust configuration, and recovery access have a separate owner-defined upgrade or recovery procedure.

## External MCP and credentials

Build one generic remote MCP client. A Git-tracked connector definition identifies its endpoint, authentication type, and a secret reference. Include DigitalOcean DNS as the first example, using the networking MCP endpoint at `https://networking.mcp.digitalocean.com/mcp`. Discover and invoke the provider’s real tools. Resolve a dedicated bearer token locally and attach it only to the configured provider. Bind secret references to owner-authorized destinations independently of agent-editable Git content. Redact credentials from chat, execution history, Git, and tool output. Enforce hard cloud-authority limits at the provider or an independently controlled service. Root on the VPS can read locally available credentials and change local connector policy.

A missing token should produce an authenticated, write-only credential field and resume the original run when supplied. The skill receives the connector’s results. It does not need the token in model context.

Use “publish orders with TLS” as a design case. The skill should inspect the existing ingress, reconcile the intended DNS record, arrange automatic ACME renewal independent of the model, and verify the hostname, certificate, and application response. A conflicting record that serves something else needs owner direction. Keep Nomad installation, host hardening, and ingress publishing as examples of capabilities the operator can acquire. The framework itself should have no hard-coded Nomad deployment workflow.

## Human interface

The home screen is a conversation with the operator. The owner can give it a task, steer or stop a run, answer a question, and supply a credential. Show current status and a reconnectable activity feed with expandable tool calls, command outcomes, skill revision, test results, and links to artifacts. Let the owner inspect memory and skills. Changes are requested conversationally. Keep host configuration, code editing, and workflow construction out of the web UI. Protect the session, mutating routes, streams, and artifact paths, and render agent output as untrusted content.

For unattended work, show a concise incident summary with the trigger, affected resource, action, verification, and whether the owner needs to act. Keep redacted detailed events available underneath. For one configured notification destination, report unresolved incidents even when the UI is closed and deduplicate repeated alerts. Reuse the connector mechanism where practical.

## Future v2 peer protocol (design context only)

V1 ends at one operator's local incident state. Keep a stable installation identity and incident IDs, and record the origin, immutable revision, and test evidence for each installed skill. Peer listeners, discovery, and communication are v2 work.

In v2, an authenticated, read-only `GET /status` could return a versioned JSON snapshot that the operator chooses to share: operator ID, sequence, expiry, available capabilities, and open help requests with stable IDs and requested assistance. Gossip is the separate exchange that periodically relays these snapshots between configured peers. Preserve and verify the originating operator's signature on forwarded snapshots, ignore duplicates and older sequences, and expire stale requests. Share a redacted summary. Keep detailed local incidents and secrets private. A peer can offer advice or a pinned skill revision directly against a request ID. The receiving operator decides under its own policy whether to test and use an offer. Permission to read status, offer help, publish a skill, and execute work are separate decisions.

## Acceptance tests and handoff

1. **Prove the core loop first.** Begin with only the authoring skill and the framework primitives. Ask the operator to build a reusable tool that summarizes failed services from a supplied text fixture. During the same task it must author, test, activate, and invoke the tool. Keep acceptance fixtures, expected outcomes, and the grader outside the candidate skill. Have the test runner independently check the actual structured result. Restart the operator, start a fresh conversation, provide a different fixture, and verify it discovers and reuses the exact revision without rewriting it. Use a held-out fixture and verify the run creates the first independent reuse record for this revision. Capture the tool calls and Git revision.
2. Exercise hot-plug and rollback through MCP. Start a call on revision A, activate revision B, verify the first call completes on A, then try a broken update and roll back. Check tool discovery against the running server.
3. Verify memory across restarts, browser disconnect/replay, and recovery after a host action succeeds but before its completion event is written. Use a harmless observable side effect and assert it happens once. Verify a second host-changing task waits its turn.
4. Demonstrate Git push/pull with a temporary bare remote and restore the operator into a fresh state directory. Verify the restored memory and skill actually work.
5. Exercise the DigitalOcean connector against a protocol-compatible test server with a dummy token. Verify discovery, missing-credential pause/resume, redaction, and DNS reconciliation on repeat. Supply an opt-in live smoke check for an explicitly designated test hostname. Live DNS changes or host-wide hardening on an unrelated machine are outside the acceptance run. For an ingress acceptance run, have the test runner request the hostname, validate TLS, and check a response specific to the expected service. A default-backend success response must fail the check.
6. Run the real Codex integration if credentials are available. Test doubles are appropriate for CI. Report exactly which end-to-end paths ran live, which used fixtures, and any missing prerequisite. Include a reproducible command for each remaining live check.

7. Give the operator a standing goal to maintain a harmless fixture's permissions. Have it author and activate the check and repair as a skill. With the UI closed, restart the services and induce drift. Verify scheduling, autonomous repair, a fresh check, and a readable incident summary. Simulate a persistent fault and verify that retries stay within one incident budget across a restart, a diagnostic follow-up run, and an attempted skill revision. Assert a single owner notification and no further repair loop. Verify a paused goal leaves the fixture alone and healthy checks make zero model calls. Exercise the boot path on a disposable VPS when available.
8. Give a previously working skill an input that reveals a defect. Verify the operator reproduces it, adds a regression case, tests its revision against old and new inputs, and uses that revision successfully. Record the exact evidence.
9. Simulate a DNS create that succeeds at the test provider but loses its reply. Kill the worker before it records completion and discard the model thread. With a fresh thread, recover intent from the checkpoint, query the provider, and finish verification. The independent test runner must see exactly one create call and one expected record. Repeat while the provider stays unreadable after the lost reply. Expect `unknown`, bounded observation attempts, zero additional writes, and one notification. Assert from the provider’s call log that neither variant silently replays the write.
10. Include a harmless service-log fixture that asks the operator to perform an unrelated action. Verify the log is retained as sourced evidence, the legitimate task still completes, and no new goal, credential grant, or unrelated side effect is created.

In your handoff, give the exact commands to start the controller and worker, open the UI, submit the first skill-creation task, and run the acceptance checks. Describe the implementation you actually verified.
