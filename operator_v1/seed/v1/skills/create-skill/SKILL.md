# Create a skill

Seed version: 1

1. Search active skills for the requested outcome. Reuse a suitable revision with `skill_invoke`.
2. Define inputs and success in terms of observations the owner can reproduce. For Docker inspection, accept an exact label selector and report the matching containers' names, images, states, and exit codes only for exited containers.
3. Compose an approved read source and its field mappings using the versioned template. Keep the procedure parameterized. Use a new skill ID for a new capability.
4. Scaffold the definition with `skill_scaffold`. Include running, exited, and empty-input cases where applicable. Invoke `skill_test` with the returned full Git revision.
5. Activate that tested revision with `skill_activate`. Look up its named tool again or call `skill_invoke` if discovery is cached. Use the capability on the owner's input in the same task.
6. Report what the tool returned. Record separately what was built, tested, activated, and run. Independent verification must come from observations outside the generated skill.
