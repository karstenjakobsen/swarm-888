import re

import httpx

from .credentials import DIGITALOCEAN_ORIGIN, CredentialError

DNS_ZONE = re.compile(
    r"(?<![\w./@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\w-]|\.[a-z0-9])",
    re.IGNORECASE | re.ASCII,
)


def requested_zone(text: str) -> str | None:
    if not re.match(r"\s*(?:please\s+)?(?:list|read)\b", text, re.IGNORECASE):
        return None
    if not re.search(r"\bdigital\s*ocean\b", text, re.IGNORECASE) or not re.search(
        r"\bdns\b", text, re.IGNORECASE
    ):
        return None
    zones = {match.group().lower() for match in DNS_ZONE.finditer(text)}
    if len(zones) != 1:
        return None
    zone = zones.pop()
    return zone if len(zone) <= 253 else None


class TokenRejected(CredentialError):
    """DigitalOcean did not accept the supplied token for this DNS read."""


async def list_dns_records(http: httpx.AsyncClient, arguments: dict) -> list[dict]:
    zone = arguments.get("zone")
    if not isinstance(zone, str) or len(zone) > 253 or not DNS_ZONE.fullmatch(zone):
        raise CredentialError("Supply one DNS zone name for the DigitalOcean read")
    records = []
    for page in range(1, 51):
        response = await http.get(
            f"{DIGITALOCEAN_ORIGIN}/v2/domains/{zone.lower()}/records",
            params={"per_page": 200, "page": page},
        )
        if response.status_code in (401, 403):
            raise TokenRejected("DigitalOcean rejected the token for DNS reads")
        if response.status_code == 404:
            raise CredentialError("DigitalOcean did not find this zone in the approved account")
        response.raise_for_status()
        try:
            payload = response.json()
            batch = payload["domain_records"]
            if not isinstance(batch, list) or not all(isinstance(row, dict) for row in batch):
                raise ValueError
            next_page = payload.get("links", {}).get("pages", {}).get("next")
        except (ValueError, KeyError, AttributeError, TypeError):
            raise CredentialError("DigitalOcean returned an invalid DNS record response") from None
        records.extend(batch)
        if not next_page:
            return records
    raise CredentialError("The DigitalOcean DNS read reached its pagination limit")
