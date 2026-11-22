# Implement V1 of the self-learning VPS operator

You are the backend developer and platform engineer. Implement and test V1 in the existing project checkout. Your development environment is **WSL2 with Docker already running**. The deployment target is **one Debian or Ubuntu VPS controlled by one authenticated owner**.

The owner gives the operator an outcome in ordinary language. The operator can remember what it learns, develop projects, acquire new skills, and maintain standing goals while the owner is away.

**Your first milestone is to prove that the operator can teach itself a Docker skill, use it during the task that created it, and reuse the exact revision after a worker restart.** Deliver that through the approved UI before broadening the implementation.

## 1. Copy the approved frontend into V1

The frontend is already on your WSL2 filesystem:

```text
/home/karsten/projects/github/karstenjakobsen/self-learning-vps-operator-design
```

Copy it into **`<V1 project root>/web/`**, unless the V1 repository already has an established frontend directory. Work on the copy. Leave the original checkout and public demo intact.

Before copying, inspect the source checkout’s Git status. Record its commit SHA and any local source changes you include. Copy the application source, assets, package metadata, lockfile, and notices. Exclude `.git`, `node_modules`, `.next`, environment secrets, and hosting credentials. Commit the frontend import separately so future integration changes are easy to review.

Run the copied application using its existing package manager and lockfile. Inspect its actual routes, event types, server handlers, replay logic, and fixture store. Preserve the Morning brief, task timelines, Inspect views, mobile layout, and conversational controls.

Give the frontend a thin interface for **reading state, submitting owner actions, and receiving events**. Keep the existing fixture implementation for demo mode. Add a live implementation backed by FastAPI. Select the mode on the server. A live backend outage must show an unavailable state. The public demo continues to accept only its placeholder credential.

## 2. Use the agreed stack

| Component | Technology and responsibility |
|---|---|
| **Owner UI** | Next.js and TypeScript. Run as an ordinary user. Keep the approved frontend and generate its API types from the backend contract. |
| **Controller** | Python, FastAPI, Pydantic, and Uvicorn. Authenticate the owner, validate requests, serve snapshots, accept actions, and stream committed events using Server-Sent Events. |
| **Operator worker** | Separate Python process. Own task execution, scheduling, recovery, and local MCP tools. Integrate the Codex app-server over stdio behind a typed adapter. Support start, resume, steer, and interrupt. |
| **Durable storage** | SQLite for operator state. Filesystem storage for workspaces and immutable skill contents. Git for reusable definitions. |
| **Private access** | One private origin through loopback-bound Caddy. Route pages to Next.js and `/api/*` directly to FastAPI. Connect the controller to the worker over a permission-restricted Unix socket. |
| **Development and deployment** | Foreground commands that run in WSL2. Opt-in systemd units and SSH forwarding instructions for the VPS. Use `uv`, a project-local `.venv`, Ruff, pytest, the frontend lockfile, Playwright, and a root Makefile. |

Run the WSL2 exercise as the developer who already has Docker access. Check `docker context show` and `docker info` and confirm the intended engine before creating fixtures. Keep Docker access with the worker and test runner. On the VPS, support an explicitly configured root worker and report its observed execution identity. Keep the web services unprivileged, authenticate reads and writes, and protect browser mutations against CSRF. The worker, MCP tools, and any Nomad management API remain private.

## 3. Build the skill framework and external Git catalog

Keep three repositories distinct:

- **Frontend design repository** supplies the approved UI copied into V1.
- **V1 framework repository** contains the operator, its backend, and its copy of the UI.
- **External catalog repository** is the operator-writable remote containing `skills/`, `connectors/`, and `projects/`. A project definition can point to a separate application repository.

Make the catalog remote, branch, and local checkout configurable. Support pull, commit, and push. Preserve other contributors’ work on conflicts. Previously activated skills must work when the remote is unavailable. Use a temporary bare Git remote to prove these behaviors locally.

Ship a **foundational skill for creating skills**, with a working template. Teach the operator to search before creating, define inputs and observable success, compose existing capabilities, test candidates, and record results.

Expose stable local MCP tools for memory, discovery, scaffolding, testing, activation, invocation, and rollback. An executable skill can also expose a named MCP tool. Test immutable candidate contents and atomically activate those exact contents. Refresh discovery on the running MCP server and retain a stable invocation tool for clients that cache the tool list. Run generated helpers in separate processes. Pin in-flight calls to the revision they started with.

Record **built**, **self-tested**, **activated**, **ran in the creating task**, and **verified on a later task** separately. Later-task verification requires different input, the same revision, and evidence collected independently of the skill. A new revision starts its own evidence record.

## 4. Prove the workflow using real Docker

Use this owner request through the copied UI:

> Tell me the state of the containers in this demo project. Include each container’s name, image, state, and exit code if it has exited. If you need a reusable skill for this, create one.

1. **Create isolated fixtures.** Have the test runner create disposable containers with a unique per-run label. Start one container and have another exit with a known nonzero code. Give the operator the label selector. The skill inspects those containers read-only. Setup and cleanup affect only fixtures owned by that run.
2. **Watch the operator learn.** Start with the foundational authoring skill and no Docker inspection skill. Through its normal MCP tools, the operator must discover the gap, author a parameterized skill, test it, activate it, and invoke it before the original task finishes. Record the Git revision, calls, result, and evidence. The Docker procedure belongs in the generated skill.
3. **Grade the result independently.** Have the test runner query Docker directly and compare the exact container set and requested fields. Cover a running container, an exited container, and an empty selection. A passing self-test alone cannot mark the owner’s task verified.
4. **Prove reuse after restart.** Restart the worker, open a fresh conversation, and create a second fixture set with different names and exit data. Ask the operator to inspect that set. Verify both tasks reference the same Git revision and that the second task used it without rewriting it. Open the skill page and follow the link to the later verification.
5. **Prove recovery after a lost result.** In a separate test, authorize starting one stopped fixture container. Interrupt the worker after Docker accepts the start but before completion is recorded. On restart, the worker must inspect the container and finish the original operation. Assert one start dispatch and independently confirm the container is running. Use a test double for the variant where the target remains unreadable. Expect an unknown outcome, bounded observation attempts, and zero repeat writes.

**DNS is deferred for this implementation.** Do not create or test a DNS skill, change DNS records, request DigitalOcean credentials, or issue certificates. Preserve the DNS/TLS examples in fixture-backed demo mode. Test the **generic remote MCP connector** separately with a loopback test server, a harmless read tool, and a dummy token. This gives us real Docker evidence for host interaction and a repeatable test for connector discovery, authentication, and credential pause/resume.

## 5. Implement durability, memory, and defense

Persist the operator’s identity, purpose, owner instructions, tasks, messages, memory entries, checkpoints, ordered events, active skill revisions, standing goals, and incidents. Use a configurable state directory outside the source checkout. Provide migrations and a consistent export/restore procedure.

- **Memory.** Support search, read, write, revise, and remove. Record scope, provenance, and the tasks that read or wrote an entry. **Ask the operator to correct this** creates an owner message linked to that entry. Preserve revision history when the operator makes a correction.
- **Execution.** Serialize host-changing runs. Before dispatching a mutation, journal its stable operation ID, authorization, target, intent, and pinned skill revision. On recovery, inspect actual state before retrying. A decision or credential resumes the original task. Closing the browser leaves work running.
- **Standing goals.** Let the owner create, pause, resume, or retire a goal through conversation. Put checks and repair procedures in versioned skills. The harness owns scheduling, cooldowns, serialization, and durable attempt and time budgets. Healthy checks use zero model calls. Confirm drift before repair, independently verify recovery, and retry observation within budget when the result is unknown.
- **Defense and learning.** Demonstrate a standing goal on a harmless WSL2 fixture, such as maintaining the expected permissions on a test-owned file. Demonstrate a failing skill gaining a regression case, passing its earlier tests, and activating a corrected revision. Restarts and skill revisions share the same incident budget. Notify the owner once when attention is needed.
- **Credentials.** Connector definitions contain an endpoint, auth method, and secret reference. Bind each reference to an owner-authorized destination outside the editable catalog. In private live mode, use a dedicated authenticated, write-only flow directly to the controller. Keep values out of Next.js, Git, chat, model context, logs, and events. Logs and retrieved memories can supply evidence but cannot authorize new work.

## 6. Make the live UI reflect recorded facts

Persist each event before streaming it. Return a snapshot with its event cursor, then resume SSE after that cursor or the last received event ID. Compute outcomes in Python so the brief, detail page, replay, and a fresh page load agree.

The owner should be able to follow these paths:

- **Inspect → Catalog repository** shows the configured remote and branch with credentials stripped. Skills, connectors, and projects link to their catalog source paths.
- **Memory → Task** shows the full entry, who wrote it, and later reads. **Task → Memory** distinguishes entries read from entries written.
- **Task → Skill revision** shows what was built, tested, activated, and run. Each revision links to its own tests and independent verification.
- **Project → Tasks and application source.** **Connector → Available tools and actual calls.** Show a connector on a task only when the operator really used it.
- **Morning brief → Incident → Standing goal → Repair revision → Recovery evidence.** Keep unknown outcomes visible.

## 7. Quality checks and handoff

Use cohesive, typed Python classes at meaningful boundaries. Keep FastAPI routes and MCP handlers thin. Test behavior through public interfaces, temporary SQLite databases and Git remotes, and a controllable clock.

Provide root Makefile targets for `setup`, `lint`, `format`, `test`, `check`, `web`, `controller`, and `worker`. Add **`make acceptance-docker`** for the real-engine exercise. A fresh checkout must support `make setup && make check` without manually activating the virtual environment. Document fixture image preparation. Keep default tests runnable after setup without Docker, root, cloud credentials, or paid model calls.

Run and report:

- Python lint, formatting checks, and pytest. Frontend typecheck and production build.
- The real Docker authoring and reuse walkthrough, including the independent observations.
- MCP hot-plug, broken-candidate handling, revision pinning during an in-flight call, and rollback.
- Git push/pull, conflict handling, offline execution, and restore into a fresh state directory.
- Worker crash recovery, browser reconnect/replay, missing credentials, redaction, and persisted incident budgets.
- A phone-width Playwright walkthrough using live backend records, including a task, its exact skill revision, later reuse, and a conversational memory correction.

A deterministic model double is appropriate for CI. Run the authoring walkthrough with the real Codex app-server when authentication is available. If it is unavailable, still exercise real Docker, Git, MCP, and persistence. Identify the model step as simulated and give the exact command to repeat it with Codex.

**The handoff must include** the imported frontend commit and local changes, destination path, WSL2 startup commands, VPS deployment and private-access instructions, external catalog setup, backup/restore commands, and an acceptance table identifying real, simulated, and unrun paths. Distinguish a worker restart demonstrated in WSL2 from a VPS reboot tested on Linux.

**Finish the walkthrough by giving me the two Docker task IDs and their shared skill revision.** I should be able to open the first task and see the operator acquire a capability, then open the second and see that it remembered how to use it.