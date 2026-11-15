# Operator implementation slices

Generated projects, connectors, and skills belong to this repository for the POC. Source is committed under `generated/` on an operator-managed branch/worktree; deployments, credentials, databases, dependencies, and logs remain outside Git. Operator workers may author generated packages while the operator core remains owner-maintained by prompt.

## Current delivery: slices 1–4

- [x] **1. Source and runtime boundaries** — portable package manifests, separate source/runtime references, existing-project compatibility, and explicit generated-source authoring instructions.
- [x] **2. Automatic Git persistence** — controller-owned managed worktree, serialized scoped commits, task/revision provenance, and visible commit failures without disturbing the owner's checkout or index.
- [x] **3. Build and deploy project revisions** — validate/build committed code, deploy to stable external runtime directories, observe independent services and logs, and display source/deployed revisions in Projects.
- [x] **4. Pluggable MCP connections** — register local packages and remote HTTP endpoints, discover and call namespaced tools, select enabled connections for project tasks, and test through the UI.
- [x] **Automated acceptance** — a local fixture connector and a simple project demonstrate registration, source commits, deployment, MCP calls, and failure handling. Backend, type/build, and browser checks pass. Systemd tests use a simulated host.
- [ ] **Host acceptance** — restart the controller/root worker; use Connections → Create local example → Test connection → echo; create a managed service in Projects, save a source edit, deploy, inspect logs/status, and stop it on a root/systemd host.

## Later delivery

- [ ] **5. Credentials and connection setup** — dedicated credential forms, backend-held secrets, authentication health, and durable tasks awaiting a connection.
- [ ] **6. Git-backed reusable skills** — commit authoring source and connect it to the existing validated immutable skill publication flow.
- [ ] **7. Complete creation workflow** — durable orchestration across project creation, code generation, connectors, skills, commits, and deployment.
- [ ] **8. Remaining lifecycle work** — consolidated lifecycle visibility, revision updates/redeployment, and wider workflow recovery. The critical runtime-operation recovery portion was brought forward during review (below).

## Delivery decisions

- One Git repository and an isolated managed branch/worktree; automatic commits do not publish or merge changes into the development checkout.
- Project/package identity and source paths are portable so packages can move into separate repositories later.
- Existing adopted projects retain their runtime paths. Source management is added explicitly.
- Connections in slices 1–4 support unauthenticated local/HTTP test servers. Provider authentication is slice 5.
- Test scenarios are local fixtures; no DigitalOcean, certificate, broker, or trading operations are included.

## Verification and handoff

Verified on 2026-11-15:

- Final review verification: 171 unit/integration tests passed, one optional live-auth test skipped; TypeScript and production build passed; all 25 browser tests passed. No separate lint task is configured. Checks reported no warnings.
- Real temporary Git repositories verify automatic scoped commits, preserving owner HEAD/index/staged/unstaged changes, immutable exports, known-credential rejection, and restart-safe source finalization.
- Real stdio and local HTTP MCP fixtures verify initialization, discovery, calls, response limits, cleanup, and failed requests. The actual pinned Codex app-server discovers and calls a dynamically registered tool without receiving controller/model/bridge credentials in its connector subprocess.
- Desktop and phone browser checks cover source edits/commits, distinct deployed revisions, deployment/log/stop controls, connector registration/testing/calls, project assignments, and stale/offline status.
- Persistent systemd installation/enabling/restart/stop, literal command arguments, checked builds, and repeat-deploy idempotency use injected host/service-manager fixtures. No real host service was installed or changed during implementation.
- A live authenticated model deployment and live root/systemd service remain host acceptance work. Critical build/MCP crash recovery has been brought forward; uncertain operations are not automatically replayed.

## Review and corrective work

- [x] **Boundaries** — transport schemas are pure shared DTOs, independent of subprocess/network clients; source and connector services use typed persistence stores and validate worker responses.
- [x] **API consistency** — shared transport/command/result limits, explicit package-kind conflicts, exact deployment revision/directory/unit checks, and consistent project refresh from UI/tools.
- [x] **Source correctness** — stale editor commits return 409; rejected writes preflight secrets, paths, sizes and structural conflicts before mutation; source creation is idempotent; only the intended package is committed.
- [x] **Concurrent observations** — older service observations cannot overwrite a newer deployment; changed connectors invalidate tests; late tests cannot re-enable or verify changed connections.
- [x] **UI correctness** — preserve drafts and commit messages, lock pending editor operations, guard navigation, synchronize project assignments, reject stale results, and display MCP tool errors.
- [x] **Runtime lifecycle** — status/logs remain responsive during builds, transitional services can be stopped, duplicate close is safe, and subprocess cleanup checks captured process ownership.
- [x] **P1 brought forward with owner approval** — worker operation journal and gated supervisor launch; durable PID/start/boot capture before execution; no new effects after restart uncertainty; ownership-safe multi-process reconciliation; explicit external-effect acknowledgement; no replay or rollback of provider/service actions.
- [x] **Receipt gap** — confirmed external outcomes persist in the controller before worker acknowledgement; lost ACK recovery sends only ACK, never the original action; authenticated bounded receipt inspection is available.
- [x] **Adversarial verification** — real temporary worker SIGKILL during local helpers, stdio and HTTP; failed identity capture cannot execute code; independent processes survive reconciliation; missing/reused identities fail closed; completed-result receipt recovery does not repeat mutations.

The managed Git lock remains deliberately fail-closed after a controller dies while holding it. Verify no source operation is running before the documented lock cleanup; no automatic lock stealing is implemented. No real root service/provider operation was performed by the test suite.

See README.md → Managed source, deployments and MCP connections for package contracts and the UI test steps.
