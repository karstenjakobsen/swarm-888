import json

from pydantic import ValidationError

from .model import ModelError, TaskReply, codex_session, final_message
from .state import State


async def recover_reply(state: State, task: str, turn_id: str | None, *, legacy: bool) -> TaskReply:
    """Read the exact saved turn, then use a tool-free review only if it lacks an answer."""
    with state.transaction() as db:
        row = db.execute("SELECT text,thread_id FROM tasks WHERE id=?", (task,)).fetchone()
        events = db.execute(
            """SELECT kind,text FROM events WHERE task=? AND kind!='system'
                            ORDER BY seq DESC LIMIT 40""",
            (task,),
        ).fetchall()
    context = {"request": row["text"], "journal": [dict(e) for e in reversed(events)]}
    async with codex_session(state.settings, task, state.profile(), answer_review=True) as session:
        if row["thread_id"] and (turn_id or legacy):
            try:
                history = await session.rpc.request(
                    "thread/read", {"threadId": row["thread_id"], "includeTurns": True}
                )
            except ModelError:
                turns = []
            else:
                turns = history["thread"]["turns"]
            turn = next((t for t in reversed(turns) if legacy or t["id"] == turn_id), None)
            if turn:
                if turn["status"] == "completed":
                    text = final_message(turn["items"])
                    try:
                        return (
                            TaskReply(status="answered", text=text)
                            if legacy
                            else TaskReply.model_validate_json(text)
                        )
                    except ValidationError:
                        pass
                context["turn_evidence"] = [
                    {k: i[k] for k in ("type", "text", "tool", "result", "status") if k in i}
                    for i in turn["items"]
                    if i["type"] in ("agentMessage", "mcpToolCall")
                ]
        # A new thread has no authority to replay previous tool calls.
        prompt = json.dumps(context, ensure_ascii=False)
        if len(prompt) > 64000:
            prompt = prompt[:32000] + "\n[Evidence omitted for length]\n" + prompt[-32000:]
        review = await session.start(prompt)
        return TaskReply.model_validate_json(await session.result(review))
