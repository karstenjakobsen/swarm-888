from .catalog import CatalogError
from .catalog_manifest import assign_canonical_id
from .connectors import ConnectorRead, ConnectorService
from .credentials import (
    DIGITALOCEAN_ORIGIN,
    DIGITALOCEAN_SCOPE,
    CredentialError,
    CredentialRequired,
    Destination,
)
from .state import RequestConflict, State
from .typed_catalogs import TypedCatalogs

CONNECTOR = "digitalocean-dns"
SKILL = "list-digitalocean-dns-records"
TOOL = "list_dns_records"
DEFINITION = {
    "name": "DigitalOcean DNS",
    "endpoint": DIGITALOCEAN_ORIGIN,
    "auth": "bearer",
    "tool": TOOL,
    "secret_ref": CONNECTOR,
    "timeout": 15,
}
GUIDE_FIELDS = {
    "name": "List DigitalOcean DNS records",
    "purpose": "Read the DNS records for one DigitalOcean zone.",
    "skill_type": "guide",
    "guide": "SKILL.md",
}
GUIDE = """# List DigitalOcean DNS records

Use the approved DigitalOcean DNS connector and pass the requested zone to
its read-only list_dns_records tool. If the credential dialog opens, wait for
the owner. Verify success against the returned DigitalOcean records.
"""


class DnsWorkflow:
    def __init__(self, state: State):
        self.state = state
        self.catalogs = TypedCatalogs(state)

    def save_catalog_item(self, kind, slug, fields, *, files=None):
        binding = self.catalogs.for_kind(kind)
        if binding is None:
            raise CatalogError(f"Connect a {kind} catalog to set up DigitalOcean DNS")
        canonical_id = assign_canonical_id(binding.publisher, kind, slug)
        for item in binding.snapshot(kind).items:
            if item.manifest.canonical_id == canonical_id:
                if any(getattr(item.manifest, field) != value for field, value in fields.items()):
                    raise CatalogError(f"Review the existing {canonical_id} catalog definition")
                return canonical_id
        self.catalogs.write_item(kind, slug, fields, files=files)
        return canonical_id

    def prepare(self, task: str, zone: str) -> str | None:
        with self.state.transaction(write=True) as db:
            existing = db.execute("SELECT * FROM dns_requests WHERE task=?", (task,)).fetchone()
            if existing and existing["phase"] != "preparing":
                return existing["connector"] if existing["phase"] == "approved" else None
            if not existing:
                db.execute(
                    "INSERT INTO dns_requests VALUES (?, ?, NULL, 'preparing')", (task, zone)
                )
                self.state.append(
                    db,
                    task,
                    "evidence",
                    f"Verify the DNS records returned by DigitalOcean for {zone}.",
                    {"action": "dns_task_objective", "zone": zone},
                )

        connector = self.save_catalog_item("connector", CONNECTOR, DEFINITION)
        skill = self.save_catalog_item("skill", SKILL, GUIDE_FIELDS, files={"SKILL.md": GUIDE})
        with self.state.transaction(write=True) as db:
            active = db.execute(
                "SELECT 1 FROM tasks WHERE id=? AND checkpoint='running'", (task,)
            ).fetchone()
            if not active:
                return None
            self.state.append(
                db,
                task,
                "evidence",
                "Validated the local DigitalOcean connector and reusable DNS guide.",
                {"action": "dns_prepared", "connector": connector, "skill": skill},
            )
            approved = db.execute(
                "SELECT 1 FROM connector_approvals WHERE connector=? AND endpoint=? AND secret_ref=?",
                (connector, DIGITALOCEAN_ORIGIN, CONNECTOR),
            ).fetchone()
            db.execute(
                "UPDATE dns_requests SET phase=?,connector=? WHERE task=?",
                ("approved" if approved else "approval", connector, task),
            )
            if not approved:
                self.state.append(
                    db,
                    task,
                    "waiting",
                    f"Approve read-only DigitalOcean DNS access for {zone}.",
                    {
                        "action": "dns_approval_required",
                        "zone": zone,
                        "destination": DIGITALOCEAN_ORIGIN,
                        "scope": DIGITALOCEAN_SCOPE,
                    },
                )
        return connector if approved else None

    def approve(self, task: str) -> None:
        with self.state.transaction(write=True) as db:
            row = db.execute(
                """SELECT d.phase,d.connector,t.checkpoint FROM dns_requests d
                   JOIN tasks t ON t.id=d.task WHERE d.task=?""",
                (task,),
            ).fetchone()
            if row and row["phase"] == "approved":
                return
            if not row or row["phase"] != "approval" or row["checkpoint"] != "running":
                raise RequestConflict("This task has no pending DigitalOcean approval")
            db.execute(
                """INSERT INTO connector_approvals VALUES (?,?,?)
                   ON CONFLICT(connector) DO NOTHING""",
                (row["connector"], DIGITALOCEAN_ORIGIN, CONNECTOR),
            )
            db.execute("UPDATE dns_requests SET phase='approved' WHERE task=?", (task,))
            self.state.append(
                db, task, "evidence", "DigitalOcean DNS read approved.", {"action": "dns_approved"}
            )

    def run(self, task: str, zone: str) -> None:
        try:
            connector = self.prepare(task, zone)
            if connector is None:
                return
            records = ConnectorService(None, self.state, task).read(
                ConnectorRead(connector=connector, arguments={"zone": zone}),
                expected_destination=Destination(
                    endpoint=DIGITALOCEAN_ORIGIN, secret_ref=CONNECTOR
                ),
            )["result"]
        except CredentialRequired:
            return
        except (CatalogError, CredentialError) as error:
            self.state.fail(task, str(error))
            return
        except OSError:
            self.state.fail(task, "Could not save or read the local DigitalOcean configuration")
            return

        if not isinstance(records, list):
            self.state.fail(task, "The DigitalOcean connector did not return a DNS record list")
            return
        count = len(records)
        noun = "record" if count == 1 else "records"
        summary = f"DigitalOcean returned {count} DNS {noun} for {zone}."
        with self.state.transaction(write=True) as db:
            if db.execute(
                "UPDATE tasks SET checkpoint='completed' WHERE id=? AND checkpoint='running'",
                (task,),
            ).rowcount:
                self.state.append(db, task, "answered", summary, {"modeled": True})
                self.state.append(
                    db,
                    task,
                    "verified",
                    summary,
                    {"action": "dns_verified", "zone": zone, "count": count},
                )
