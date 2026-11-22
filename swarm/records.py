"""Read-only projections of operator records for the owner's Brain view."""

# Keep credential columns out of both the response and the SELECT.
TABLES = {
    "memory": "id, project, job, body, created",
    "jobs": "id, project, kind, prompt, target, state, worker, result, created, attempts, turn",
    "events": "id, job, message, at",
    "projects": "id, name, repo, revision, thread, auto_publish, repo_ref",
    "shared_catalog": "id, directory",
    "peers": "id, name, url",
    "invites": "project",
}
PAGE_SIZE = 20


def page(store, table, before=None):
    if table not in TABLES:
        raise KeyError("Unknown table")
    where, args = "", ()
    if before is not None:
        if not 0 < before < 2**63:
            raise ValueError("Invalid record cursor")
        where, args = "WHERE rowid < ?", (before,)
    rows = store.query(
        f"SELECT rowid AS record, {TABLES[table]} FROM {table} {where} ORDER BY rowid DESC LIMIT ?",
        (*args, PAGE_SIZE + 1),
    )
    return {
        "rows": rows[:PAGE_SIZE],
        "next": rows[PAGE_SIZE - 1]["record"] if len(rows) > PAGE_SIZE else None,
    }
