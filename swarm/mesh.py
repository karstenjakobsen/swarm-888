"""Paired operators share only idempotent tasks, status and results."""

import asyncio
import json
from urllib import error, request

from .store import BlockedTask


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exchange(peer, method, path, body=None):
    payload = json.dumps(body).encode() if body is not None else None
    req = request.Request(
        peer["url"] + "/mesh/v1" + path,
        data=payload,
        method=method,
        headers={"Authorization": "Bearer " + peer["token"], "Content-Type": "application/json"},
    )
    try:
        with request.build_opener(NoRedirect).open(req, timeout=8) as resp:
            return json.loads(resp.read(128 * 1024))
    except error.HTTPError as exc:
        exc.close()
        if exc.code in (429, 502, 503, 504):
            raise ConnectionError(f"Peer unavailable ({exc.code})") from None
        raise ValueError(f"Peer rejected request ({exc.code})") from None


async def delegate(store, job):
    peer = store.one("SELECT * FROM peers WHERE id=?", (job["target"],))
    delay = 1
    remote = None
    while True:
        try:
            if remote is None:
                remote = await asyncio.to_thread(
                    exchange,
                    peer,
                    "POST",
                    "/runs",
                    {"prompt": job["prompt"], "request_id": job["id"]},
                )
                store.event(job["id"], "Accepted by " + peer["name"])
            else:
                remote = await asyncio.to_thread(exchange, peer, "GET", "/runs/" + remote["id"])
            if remote["state"] == "completed":
                return remote["result"]
            if remote["state"] == "blocked":
                raise BlockedTask("Peer blocked: " + remote["result"][:2000])
            if remote["state"] in ("failed", "cancelled"):
                raise ValueError("Peer " + remote["state"] + ": " + remote["result"][:2000])
            delay = 2
        except OSError, TimeoutError:
            if delay == 1:
                store.event(job["id"], "Peer unavailable. Retrying delivery.")
            delay = min(delay * 2, 30)
        await asyncio.sleep(delay)
