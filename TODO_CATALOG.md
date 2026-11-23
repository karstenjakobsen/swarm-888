# Typed catalogs V1

V1 supports one owner, one operator, and at most one connection per catalog kind. The kinds are `skill`, `connector`, and `project`. Each connection reads and writes the same branch, with `main` as the default. Several kinds can share one repository and branch. A shared branch has one checkout, one sync lock, and one publish preview.

The framework ships `create-skill` and `connect-catalog`. An owner task can authorize the operator to author, test, activate, and use its own skill within the existing permissions. Pulling a revision makes it discoverable and leaves any active SHA pinned. Publishing requires an explicit owner action.

## 1. Define the manifest contract and discovery

- [x] Define a versioned `operator.yaml` schema with exactly one item per manifest. Common fields are `schema_version`, `kind`, `canonical_id`, and `name`. Reuse the existing skill, connector, and project contracts for type-specific validation.
- [x] Discover only `operator.yaml` at the repository root and `*/operator.yaml` in immediate subfolders. Read from a specific Git commit. A skill declares its input schema, executable, self-tests, and any runtime dependencies. The executable and tests sit beside the manifest. Reject unsafe paths and symlinks. A connector declares an endpoint, tool, and credential reference. A project declares its separate application repository.
- [x] Provide the harness ID allocator for `<publisher>-<kind>-<slug>` and verify it with `karstenjakobsen` for the `packages-888` fixture. Compare the full stored `canonical_id` exactly. Check uniqueness across all kinds before filtering. A duplicate reports both paths, and the previous valid commit and active skill revision remain usable.
- [x] Report the repository, branch, full commit SHA, manifest path, kind, and canonical ID in discovery. Verify root discovery, immediate-child discovery, deeper files being ignored, a folder move, and a cross-kind duplicate. Expose read-only discovery through `python -m operator_v1.catalog_cli discover`.
- [x] Commit a change to `run.lua` and verify that the discovered Git revision changes while the canonical ID stays the same.

The shared repository can start with this layout.

| Manifest | Kind | Purpose |
| --- | --- | --- |
| `check-disk/operator.yaml` | `skill` | Disk usage skill with its executable and tests beside the manifest |
| `digital-ocean/operator.yaml` | `connector` | Fixture connector definition and credential reference used without a live DNS operation |
| `kj-api/operator.yaml` | `project` | Project definition pointing to its own application repository |

## 2. Bundle the built-ins and connect typed catalogs

- [x] Load `create-skill` and `connect-catalog` from the framework at startup. Show their framework provenance. `connect-catalog` guides the owner through the harness setup flow. `create-skill` can explain the format before setup and needs a skills connection to save a new item.
- [x] Persist typed connections separately from Git checkout state. Key checkout and sync state by repository and branch. Keep Git operations in the harness and reuse the existing SSH setup, authenticated owner API, and branch validation.
- [x] Let the owner enter a repository and branch once and select Skills, Connectors, and Projects together. Show each connection and its discovered items in Inspect. Connecting the same repository, branch, and kind again is idempotent and creates zero commits. Keep a change to an existing kind binding explicit.
- [x] Verify fresh startup with both built-ins and zero connected catalogs. Attach all three kinds to one prepared branch and confirm that they use one checkout and lock. In a separate fixture, attach different kinds to different repositories and verify that an attempt to add a second connection for the same kind requires an explicit switch.

## 3. Author typed items and preserve pinned execution

- [x] Route writes for each kind to its connected repository and branch. Have the harness assign `<publisher>-<kind>-<slug>` on first creation, using `karstenjakobsen` for `packages-888`. Store the assigned ID in the manifest and reuse it through edits and folder moves. Write shallow YAML manifests and commit through the shared checkout lock. Keep type-specific authorization in the existing harness. Connector credentials and owner endpoint bindings remain outside Git.
- [x] Reuse the task-bound MCP path for skills. Let an authorized task author, test, activate, and immediately invoke its own candidate. Keep the exact Git SHA and retained contents through testing, activation, and dispatch. Journal the task, tests, activation, invocation, and result against that revision.
- [x] On pull, validate and refresh discovery for every kind sharing the branch. Keep the running skill selected by its active SHA, including when a newer manifest is discovered or the item moves. Show the discovered and active revisions separately in Inspect. A rejected snapshot leaves the previous valid snapshot and active skill usable.
- [x] Verify a newly authored skill runs in its creating task. Fetch a newer revision with the same canonical ID, invoke the skill once, and check the reported SHA and output against the retained old revision.

## 4. Preview and publish a shared branch

- [x] Build an owner-visible preview from the remote branch tip to the local tip. Show every pending commit with its full SHA, subject, and every changed path, including paths outside connected kinds and paths with no owning manifest. Show affected items with kind, canonical ID, and manifest path. Attribute changes to a skill's executable or test file to that skill even when its manifest is unchanged. Show moves and removals and group a folder move under the item's existing canonical ID.
- [x] Keep **Publish** branch-wide. Check that the local and remote tips still match the reviewed preview before pushing. Require a refreshed preview if either tip changes. Use the existing non-force Git push and preserve local commits on conflicts or network failures.
- [x] Keep read and publish verification separate. Mark publish verified only after an actual push is confirmed on the remote branch. Keep the existing checks for publishing changed skill contents. Allow an authorized local connector definition to be included in the same publish as a tested, active skill.
- [x] Verify that a preview groups the new skill commit and the pending connector commit into one publish, lists both affected items by kind, and matches exactly what reaches the temporary remote. In a Skills-only setup, verify that the same branch preview still includes a pending connector change and all other changed paths. Include a skill asset-only change and verify its attribution. Verify that a stale preview cannot be published.

## 5. Provide and rehearse migration

- [x] Implement and document a migration command for the existing `packages-888/main` layout and bound operator state. Provide a dry run that reports the proposed kind bindings, path conversions, IDs, and collisions. Apply produces a local migration commit for the owner to review and publish. Document the exact commands for the real catalog and the backup and recovery sequence.
- [x] Convert the legacy `skills/`, `connectors/`, and `projects/` definitions to shallow manifests. Move foundational authoring to the built-in skill. Preserve existing task IDs, journal evidence, Git provenance, and retained executable revisions. Record any legacy ID mapping so existing task links and active records remain resolvable.
- [x] Rehearse with a copy of existing operator state and a temporary Git remote. Open a pre-migration task through its original URL, follow its revision link, and invoke its pinned skill. Verify the original SHA and expected result. Show the copied state's migration preview, migration commit, and post-migration bindings.
- [x] Run migration again on the copy and verify zero file changes, commits, or duplicate bindings. Rehearse interruption after the local migration commit and before SQLite records the new bindings. Rerun migration, reuse that commit, and verify the original task and revision links still resolve and the pinned skill still runs.

## 6. Run the end-to-end walkthrough

- [x] Start with a fresh operator and a temporary Git remote laid out like `packages-888/main`. Show the two built-ins, select all three catalog kinds in one setup submission, and discover an item of each kind from the same full SHA. Repeat setup and independently verify zero new commits.
- [x] Submit an owner task. Have the operator author, test, activate, and invoke a missing skill. Add a separate pending connector commit on the shared branch. Show both pending commits and both affected items in the publish preview. Publish as the owner and independently confirm the remote tip.
- [x] From a second checkout, publish a revised version of the new skill whose fixture output differs. Pull it into the operator and invoke the skill once. Show the new discovered SHA and prove the invocation still executed the old SHA and produced the old result.
- [x] Include the migration rehearsal from slice 5 in the handoff, including the repeated run and interruption recovery. Provide the task links, relevant full SHAs, shared publish preview, independent Git and invocation evidence, and the real migration command. Record whether authoring used real Codex or the deterministic test double.
- [x] Run `make check` and the live browser walkthrough. Use the temporary remote for the walkthrough and the copied state for the migration rehearsal.


## Review and verification

| Slice | Review finding and verification |
| --- | --- |
| 2 | Catalog bindings live in SQLite and Git checkout operations stay in the harness. Existing owner authorization and SSH provisioning cover the new setup. Tests cover startup guides, one checkout and lock, repeat setup, and an explicit switch across separate repositories. |
| 3 | The existing MCP executor and test and activation journal run the typed skill. Pulled manifests refresh discovery independently from activation. Tests cover a task authoring and running its skill, project and connector writes, retained reuse after pull, and a rejected duplicate snapshot. |
| 4 | The owner API and CLI both require the reviewed tips for a typed push. Publish previews come from Git commits and paths, independent of the selected kinds. Tests cover a Skills-only view, asset-only attribution, unrelated paths, and stale local and remote tips. |
| 5 | The migration uses a temporary Git index and records the prepared commit before binding kinds. The dry run and backup preserve the source database schema. Tests cover interruption, a byte-identical repeat of SQLite state, a clean checkout, and backup and restore of the migrated catalog. |
| 6 | Live Chromium exercised owner sign-in, setup, reviewed publishing, and original task and revision navigation. Loopback services were stopped after the tests. The new authoring run used the deterministic model double. The migration also replayed a retained skill from an earlier real Codex acceptance run and checked it against Docker. |

`make check NEXT_BUILD_FLAGS=--webpack` passed with 34 Python tests passed and one optional test skipped. The two catalog Playwright tests and the follow-up revision page assertion passed. Webpack provided the production build and frontend type check after Turbopack's build socket was denied in this environment.

### Walkthrough evidence

Both task routes refer to the retained state beside [the typed walkthrough evidence](/tmp/swarm-catalog-v1-final/catalog-typed-NSXy1z/evidence.json). Start the [local services](README.md#run-on-wsl2) with that run's state directory to reopen the routes.

- Creating task `/work/b436b4dba0314cc293f002078f9206f5` returned `old:swarm.test=a`. Reuse task `/work/b0f69fe9a75b42f99831340d6b7241ec` returned `old:swarm.test=b`. Both invoked `1d2ac0c7e8d0a295b8b970d25b1d66e637bef4d8` after discovery moved to `b8beebe130ecfd8efebd55d26019e94aefc0249e` for the reuse task.
- The reviewed preview contained the skill commit `1d2ac0c7e8d0a295b8b970d25b1d66e637bef4d8` with its manifest, Lua file, and tests, and the connector commit `6944d16f7c37db3286e584214c56aef0f24cb5db` with `digital-ocean/operator.yaml`. Git independently confirmed the published tip `6944d16f7c37db3286e584214c56aef0f24cb5db`.
- The copied migration task `/work/dd9f74b358b143df9667c1c1fa81198c` opened its original revision `8839aa367ac3e6f2240939d94b2ad870d49c5a74`. The migration resumed commit `4d909dacc53db939819e22adbf3c054063581c5b` and a repeat left the database and checkout unchanged. The old skill ran at the original SHA and returned an empty selection, which independently matched Docker. [Migration evidence](/tmp/swarm-catalog-v1-final/catalog-migration-g2p004/evidence.json).

The [migration commands](README.md#migrate-an-existing-catalog) cover the real catalog. The [VPS runbook](deploy/README.md) shows how to run them as the service account.
