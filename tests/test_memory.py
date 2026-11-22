import asyncio
from uuid import uuid4

from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_skills import bootstrap

from operator_v1.model import skill_server
from operator_v1.state import State


def test_memory_mcp_records_scope_versions_and_task_provenance(tmp_path):
    settings, _ = bootstrap(tmp_path)
    state = State(settings)
    author, editor, reader = (
        state.submit(uuid4(), text) for text in ("Remember it", "Correct it", "Recall it")
    )

    async def call(task, name, **arguments):
        async with (
            stdio_client(skill_server(settings, task)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            return await session.call_tool(name, arguments)

    async def exercise():
        written = await call(
            author,
            "memory_write",
            title="Fixture port",
            kind="fact",
            scope="fixture",
            text="The fixture listens on port 8080.",
        )
        assert not written.isError
        memory = written.structuredContent["memory"]
        read = await call(
            editor, "memory_read", memory=memory, reason="Owner requested correction."
        )
        assert read.structuredContent["revision"] == 1
        updated = await call(
            editor,
            "memory_revise",
            memory=memory,
            expected_revision=1,
            text="The fixture listens on port 8443.",
        )
        assert updated.structuredContent["revision"] == 2
        stale = await call(
            editor, "memory_revise", memory=memory, expected_revision=1, text="Stale."
        )
        assert stale.isError
        matches = await call(reader, "memory_search", scope="fixture", query="8443")
        assert matches.structuredContent["matches"][0]["memory"] == memory
        latest = await call(reader, "memory_read", memory=memory, reason="Answer the follow-up.")
        assert latest.structuredContent["text"] == "The fixture listens on port 8443."
        assert latest.structuredContent["writer"] == editor
        assert (
            await call(editor, "memory_remove", memory=memory, expected_revision=2)
        ).structuredContent["revision"] == 3
        assert (await call(reader, "memory_read", memory=memory, reason="Already removed.")).isError
        assert (await call(reader, "memory_search", scope="fixture")).structuredContent[
            "matches"
        ] == []
        return memory

    entry = asyncio.run(exercise())
    with state.transaction() as db:
        assert [
            tuple(row)
            for row in db.execute(
                "SELECT revision,writer,removed FROM memory_versions WHERE memory=? ORDER BY revision",
                (entry,),
            )
        ] == [(1, author, 0), (2, editor, 0), (3, editor, 1)]
        assert [
            tuple(row)
            for row in db.execute(
                "SELECT revision,task FROM memory_reads WHERE memory=? ORDER BY id", (entry,)
            )
        ] == [(1, editor), (2, reader)]
