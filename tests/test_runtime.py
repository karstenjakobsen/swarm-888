import asyncio
import json
import os
import socket
import threading

from swarm.application import Application
from swarm.root_worker import FixtureWorker, broker
from swarm.runtime import CodexRuntime


def test_codex_stdio_steer_interrupt_resume(app, tmp_path, monkeypatch):
    binary = tmp_path / "codex"
    binary.write_text("""#!/usr/bin/python3
import json,sys
from pathlib import Path
if '--version' in sys.argv:
    print('codex-cli 0.166.0')
    sys.exit(0)
def send(message):
    print(json.dumps(message),flush=True)
for line in sys.stdin:
    request=json.loads(line)
    method=request['method']
    with Path('transcript').open('a') as f:
        f.write(json.dumps(request)+'\\n')
    if 'id' not in request:
        continue
    result={}
    if method in ('thread/start','thread/resume'):
        result={'thread':{'id':'fixture-thread'}}
    if method=='turn/start':
        result={'turn':{'id':'fixture-turn'}}
    send({'id':request['id'],'result':result})
    if method=='turn/interrupt' or method=='turn/start' and 'Finish now' in str(request):
        status='interrupted' if method=='turn/interrupt' else 'completed'
        send({'method':'turn/completed','params':{'turn':{'id':'fixture-turn','status':status}}})
""")
    binary.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    monkeypatch.delenv("SWARM_CODEX_AUTH", raising=False)
    actual = Application(app.state, app.catalog, CodexRuntime())

    async def scenario():
        task = actual.submit("Start a transcript test")
        work = asyncio.create_task(actual.step())
        async with asyncio.timeout(5):
            while not actual.runtime.turn:
                await asyncio.sleep(0.01)
        await actual.follow(task, "Use the billing project")
        await actual.stop(task)
        await work
        assert (
            actual.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "interrupted"
        )
        await actual.follow(task, "Finish now")
        await actual.step()
        assert actual.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "answered"
        requests = [
            json.loads(line)
            for line in (actual.state.path / "workspaces" / task / "transcript")
            .read_text()
            .splitlines()
        ]
        names = [r["method"] for r in requests]
        assert names.count("thread/start") == 1 and names.count("thread/resume") == 1
        assert "turn/steer" in names and "turn/interrupt" in names
        assert requests[-1]["params"]["input"][0]["text"].endswith("Finish now")

    asyncio.run(scenario())


def test_fixture_broker_protocol_without_elevation(app):
    path = app.state.path / "fixtures" / "sample"
    path.write_text("sample")
    path.chmod(0o644)
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    with parent, child:
        fd = os.open(app.state.path, os.O_DIRECTORY)
        thread = threading.Thread(target=broker, args=(parent, fd, os.getuid()), daemon=True)
        thread.start()
        worker = FixtureWorker(path.parent, child.detach())
        try:
            assert worker.uid == os.getuid()
            assert worker.apply("sample") == "644"
            worker.apply("sample", "644", "600")
            assert worker.apply("sample") == "600"
            import pytest

            with pytest.raises(ValueError):
                worker.apply("../secrets", "600", "644")
            with pytest.raises(ValueError):
                worker.apply("sample", "600", "777")
        finally:
            worker.channel.close()
            thread.join(2)
            os.close(fd)
