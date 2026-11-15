# Generated packages

The operator stores project, connector, and future skill authoring source under these paths on the `operator/generated` branch of this repository:

```text
generated/projects/<project-id>/
generated/connectors/<project-id>/
generated/skills/<project-id>/
```

The controller maintains a separate linked worktree at `APP_STATE_DIR/workspaces/managed`. Automated source commits do not change the development checkout's branch, index, or working files. The Projects UI shows the source path, branch, and revision. No automatic push or merge is performed.

Every package declares `operator-package.json` with its identity and optional argv-based check, build, run, or MCP configuration. Packages are self-contained and must not import operator internals. The current source editor supports bounded UTF-8 text packages.

Credentials, application state, dependencies, logs, and build output stay outside committed source. Deployed snapshots live in the registered project's runtime directory. Git-backed publication of application skills is a later slice; existing skills continue to use the state-backed publication flow.
