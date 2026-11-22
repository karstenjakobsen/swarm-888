"""An independent acceptance probe for an owner-designated HTTPS service."""

import re
import ssl

import httpx


def verify_ingress(
    hostname: str, marker: str, *, ca_file: str | None = None, port: int = 443
) -> dict:
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", hostname) or not marker.strip():
        raise ValueError("Specify a hostname and service-specific response marker")
    context = ssl.create_default_context(cafile=ca_file)
    with httpx.Client(
        verify=context, follow_redirects=False, trust_env=False, timeout=10
    ) as client:
        with client.stream("GET", f"https://{hostname}:{port}/") as response:
            content = bytearray()
            for data in response.iter_bytes(16384):
                content.extend(data)
                if len(content) >= 1_048_576:
                    break
            return {
                "hostname": hostname,
                "http_status": response.status_code,
                "verified": response.status_code == 200 and marker.encode() in content,
            }
