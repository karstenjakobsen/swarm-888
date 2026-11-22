"""Publish a redacted incident to one owner-configured destination."""

import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class Destination:
    def __init__(
        self, directory: Path, endpoint: str = "", transport: httpx.BaseTransport | None = None
    ):
        self.directory = directory
        self.endpoint = endpoint.rstrip("/")
        self.transport = transport
        if endpoint:
            url = urlsplit(endpoint)
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                raise ValueError("Use an owner-configured HTTPS alert collection")

    def deliver(self, key: str, payload: str) -> None:
        if self.endpoint:
            # The receiver upserts one alert at this URL even when the first reply was lost.
            with httpx.Client(
                transport=self.transport, trust_env=False, follow_redirects=False, timeout=4
            ) as client:
                response = client.put(
                    self.endpoint + "/" + key,
                    headers={"Content-Type": "application/json", "Idempotency-Key": key},
                    content=payload,
                )
                response.raise_for_status()
            return
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = self.directory / (key + ".json")
        if target.exists():
            return
        tmp = self.directory / ("." + uuid.uuid4().hex)
        tmp.write_text(payload)
        try:
            os.link(tmp, target)
        except FileExistsError:
            pass
        finally:
            tmp.unlink()
