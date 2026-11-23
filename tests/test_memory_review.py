import asyncio
from contextlib import asynccontextmanager
from uuid import uuid4

from mcp import ClientSession
from mcp.client.stdio import stdio_client

from operator_v1.config import Settings
from operator_v1.memory import MemoryStore, SearchMemory
from operator_v1.memory_review import MemoryReview
from operator_v1.model import skill_server
from operator_v1.state import State


def test_operator_can_choose_to_save_or_skip_a_memory_from_verified_work(tmp_path, monkeypatch):
    settings = Settings(tmp_path)
    state = State(settings)
    review = MemoryReview(state)
    tasks = [state.submit(uuid4(), f"List DNS records for {i}.example.com") for i in (1, 2)]
    with state.transaction(write=True) as db:
        for i, task in enumerate(tasks, start=1):
            zone = f"{i}.example.com"
            db.execute(
                "INSERT INTO dns_requests VALUES (?, ?, 'test-dns', 'approved')", (task, zone)
            )
            db.execute("UPDATE tasks SET checkpoint='completed' WHERE id=?", (task,))
            state.append(
                db,
                task,
                "evidence",
                "Read DNS using the approved connector.",
                {
                    "action": "connector_used",
                    "connector": "test-dns",
                    "result": [{"data": "raw-DNS-value"}],
                    "fingerprint": "vault-fingerprint",
                },
            )
            state.append(
                db,
                task,
                "verified",
                "The provider returned a DNS result.",
                {"action": "dns_verified", "zone": zone, "count": i},
            )

    @asynccontextmanager
    async def model(runtime, task, _profile, *, memory_review):
        assert memory_review
        parameters = skill_server(runtime, task, memory_review=memory_review)
        async with stdio_client(parameters) as (read, write), ClientSession(read, write) as mcp:
            await mcp.initialize()
            assert {tool.name for tool in (await mcp.list_tools()).tools} == {
                "memory_search",
                "memory_read",
                "memory_write",
            }
            assert (await mcp.call_tool("goal_list", {})).isError

            class Operator:
                async def start(self, context):
                    assert "dns_verified" in context and "test-dns" in context
                    assert "raw-DNS-value" not in context and "vault-fingerprint" not in context
                    return task

                async def result(self, _turn):
                    assert not (await mcp.call_tool("memory_search", {"query": "DNS"})).isError
                    if task == tasks[0]:
                        result = await mcp.call_tool(
                            "memory_write",
                            {
                                "title": "Operator chose this note",
                                "kind": "fact",
                                "text": "First read.",
                            },
                        )
                        assert not result.isError
                    return "Review finished."

            yield Operator()

    monkeypatch.setattr("operator_v1.memory_review.codex_session", model)
    for task in tasks:
        assert review.pending() == task
        asyncio.run(review.run(task))
    assert review.pending() is None
    matches = MemoryStore(state, None).search(SearchMemory())["matches"]
    assert [entry["title"] for entry in matches] == ["Operator chose this note"]
    snapshot = state.snapshot()
    assert all(task.outcome.key == "verified" for task in snapshot.tasks)
    assert [
        event.task for event in snapshot.events if event.data.get("action") == "memory_written"
    ] == [tasks[0]]
