# Connect a catalog

Ask the owner to open **Inspect → Catalog**. Enter the repository and branch once and select the kinds that use that branch. The branch defaults to main. The harness uses the configured SSH identity and validates the committed manifests before making the connection.

Manifest locations are operator.yaml at the repository root and */operator.yaml in immediate subfolders. Every manifest declares one skill, connector, or project. Each kind has one connection. Git synchronization and publishing operate on the shared repository branch.

Use the catalog tab to see the discovered commit and items. Skill activation still requires self-tests on an exact revision. Publishing requires the owner's approval of the branch preview.
