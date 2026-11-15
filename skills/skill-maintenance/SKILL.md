---
name: skill-maintenance
description: Create, evaluate, publish, correct, roll back and retire durable operator skills after an explicit request or an observed reusable lesson.
---

Search `skill_search` for the task before creating a package. Read likely matches with `skill_read`. Keep machine paths and credentials out of reusable instructions; use parameters or sourced memory instead.

1. Identify a repeated procedure or an explicit owner request. A single speculative lesson rarely warrants a new skill. Record facts and checked observations with `memory_write`; distinguish inferences.
2. Call `skill_create` with the existing or new name, a `files` map including this frontmatter format in `SKILL.md`, and representative `checks`. A revision creates a new candidate and never overwrites a version used by a running task.
3. Give each check a name, command, argument array, temporary fixture files, a bounded timeout, and expected stdout or expected output files. `{skill}` resolves to the copied candidate package and `{fixture}` to an isolated temporary check directory. Helpers live in `scripts/` and every executable helper needs a representative check that invokes it. Do not use live host services as test fixtures.
4. Call `skill_validate` and inspect actual worker identity, command exit codes, stdout, stderr, duration and assertions. Fix a failed candidate by creating a revision with corrected instructions or helpers. Metadata validation alone is insufficient.
5. After checks pass, call `skill_publish` to publish and activate. Future runs discover the immutable version through the runtime's local skill discovery. The current run retains its version snapshot. Do not claim a newly published procedure has worked on a real task until observed.
6. On later use, call `skill_outcome` with the exact loaded version and an observed success, failure or correction. Run-level token/time data is available independently; it does not establish that a skill caused an improvement.
7. Use `skill_action` to disable an unreliable package, roll back to a known version, or retire obsolete knowledge. Preserve old versions and evidence. Link or supersede outdated memory instead of silently rewriting provenance.

Call `progress_checkpoint` at meaningful milestones so interrupted work has a resumable summary. Improvement runs have a separate one-turn/time budget; never trigger recursive improvement work or extend their own budget.

The optional helper `scripts/summarize-evidence.mjs <evidence.json>` summarizes a JSON array of representative check results as passed and failed counts. It is a deterministic reporting aid, not proof that unobserved tasks succeeded.
