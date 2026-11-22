"""Local dashboard API and the separate, project-scoped peer API."""

import hmac
import json
import re
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import parse_qs, urlsplit

from . import catalog, shared_catalog, web
from .store import Conflict, uid

ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    **{
        "/" + f: (f, "application/javascript")
        for f in ("api.js", "dashboard.js", "workspaces.js", "peers.js", "vendor/alpine-csp.js")
    },
}


def text(data, key, limit, optional=False):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
        raise ValueError("Invalid " + key)
    return value.strip()


def public_run(job):
    return {key: job[key] for key in ("id", "state", "result")}


class Dashboard(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, store, engine, secret, name):
        self.store, self.engine, self.secret, self.name = store, engine, secret, name
        super().__init__(addr, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "Swarm"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *args):
        pass

    def reply(self, status, value, mime="application/json", cookie=None):
        body = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.handle_route()

    def do_GET(self):
        self.handle_route()

    def handle_route(self):
        try:
            self.route()
        except ConnectionError, TimeoutError:
            return
        except Conflict as exc:
            self.reply(409, {"error": str(exc)})
        except (ValueError, TypeError) as exc:
            self.reply(400, {"error": str(exc)})
        except KeyError:
            self.reply(404, {"error": "Record not found"})
        except Exception:
            import logging

            logging.exception("Request failed")
            self.reply(500, {"error": "Request failed. Check the operator log."})

    def route(self):
        url = urlsplit(self.path)
        path = url.path
        mesh = path.startswith("/mesh/v1/")
        host = self.headers.get("Host", "")
        port = self.server.server_port
        if not mesh and host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return self.reply(403, {"error": "Local access required"})
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + host:
            return self.reply(403, {"error": "Invalid origin"})
        data = {}
        if self.command == "POST":
            n = int(self.headers.get("Content-Length", "0"))
            if self.headers.get_content_type() != "application/json" or not 0 < n <= 96000:
                return self.reply(400, {"error": "Expected a JSON request under 96 KB"})
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict):
                raise ValueError("Expected an object")
        if mesh:
            return self.mesh(path, data)
        if self.command == "GET" and path == "/favicon.ico":
            return self.reply(204, b"", "image/x-icon")
        if self.command == "GET" and path in ASSETS:
            asset, mime = ASSETS[path]
            return self.reply(
                200,
                web.index() if path == "/" else files("swarm.web").joinpath(asset).read_bytes(),
                mime,
            )
        if self.command == "POST" and path == "/api/session":
            if hmac.compare_digest(text(data, "token", 256).encode(), self.server.secret.encode()):
                return self.reply(
                    200,
                    {},
                    cookie="swarm_session_"
                    + str(port)
                    + "="
                    + self.server.secret
                    + "; HttpOnly; SameSite=Strict; Path=/",
                )
            return self.reply(401, {"error": "Invalid operator key"})
        cookies = SimpleCookie()
        cookies.load(self.headers.get("Cookie", ""))
        cookie_name = f"swarm_session_{port}"
        token = cookies[cookie_name].value if cookie_name in cookies else ""
        if not hmac.compare_digest(token.encode(), self.server.secret.encode()):
            return self.reply(401, {"error": "Open the access link printed by the server"})
        db = self.server.store
        if self.command == "GET" and path == "/api/state":
            project = parse_qs(url.query).get("project", ["inbox"])[0]
            p = db.project(project)
            jobs = db.query(
                """SELECT j.id,j.project,j.kind,substr(j.prompt,1,300) AS prompt,j.state,j.worker,j.created, (SELECT message FROM events WHERE job=j.id ORDER BY id DESC LIMIT 1) AS activity
                FROM jobs j WHERE project=? ORDER BY created DESC,rowid DESC LIMIT 80""",
                (project,),
            )
            running = db.query("""SELECT j.id,j.worker,j.project,j.prompt,p.name,(SELECT message FROM events WHERE job=j.id
                ORDER BY id DESC LIMIT 1) AS activity FROM jobs j JOIN projects p ON p.id=j.project WHERE state='running'""")
            return self.reply(
                200,
                {
                    "operator": self.server.name,
                    "capacity": self.server.engine.count,
                    "projects": db.query(
                        "SELECT id,name,repo,repo_ref,revision,auto_publish FROM projects ORDER BY rowid"
                    ),
                    "sharedCatalog": shared_catalog.info(db),
                    "peers": db.query("SELECT id,name,url FROM peers ORDER BY name"),
                    "jobs": jobs,
                    "active": running,
                    "catalog": []
                    if p["id"] == shared_catalog.PROJECT
                    else catalog.assets(db.workspace(p["id"])),
                    "queued": db.one("SELECT count(*) AS n FROM jobs WHERE state='queued'")["n"],
                },
            )
        if self.command == "GET" and (m := re.fullmatch(r"/api/runs/([0-9a-f]{32})", path)):
            return self.reply(
                200,
                {
                    "job": db.job(m[1]),
                    "events": db.query(
                        "SELECT message,at FROM (SELECT * FROM events WHERE job=? ORDER BY id DESC LIMIT 150) ORDER BY id",
                        (m[1],),
                    ),
                },
            )
        if self.command == "POST":
            if path == "/api/projects":
                repo = text(data, "repository", 2048, True)
                if repo:
                    repo = catalog.repository_url(repo)
                return self.reply(
                    201,
                    db.create_project(
                        text(data, "name", 80),
                        repo,
                        data.get("auto_publish") is True,
                        catalog.git_ref(text(data, "ref", 200, True)),
                    ),
                )
            if path == "/api/runs":
                kind = data.get("kind", "task")
                if kind not in ("task", "publish", "import"):
                    raise ValueError("Unknown run type")
                project = text(data, "project", 64)
                if kind != "task" and not db.project(project)["repo"]:
                    raise ValueError("Link a repository when creating this workspace")
                prompt = (
                    text(data, "prompt", 20000)
                    if kind == "task"
                    else {"import": "Import repository", "publish": "Publish catalog changes"}[kind]
                )
                target = text(data, "target", 64, True) if kind == "task" else ""
                job = db.enqueue(
                    project, prompt, kind, target, text(data, "request_id", 128, True) or None
                )
                return self.reply(201, job)
            if path == "/api/invites":
                return self.reply(201, {"token": db.invite(text(data, "name", 80))})
            if path == "/api/peers":
                ident = uid()
                db.update(
                    "INSERT INTO peers(id,name,url,token) VALUES(?,?,?,?)",
                    (
                        ident,
                        text(data, "name", 80),
                        catalog.https_url(text(data, "url", 2048), local=True),
                        text(data, "token", 256),
                    ),
                )
                return self.reply(201, {"id": ident})
        self.reply(404, {"error": "Unknown route"})

    def mesh(self, path, data):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return self.reply(401, {"error": "Peer credential required"})
        db = self.server.store
        try:
            project = db.peer_project(header[7:])
        except KeyError:
            return self.reply(403, {"error": "Unknown peer credential"})
        if self.command == "POST" and path == "/mesh/v1/runs":
            job = db.enqueue(
                project, text(data, "prompt", 20000), key=text(data, "request_id", 128)
            )
            return self.reply(202, public_run(job))
        if self.command == "GET" and (m := re.fullmatch(r"/mesh/v1/runs/([0-9a-f]{32})", path)):
            job = db.job(m[1])
            if job["project"] == project:
                return self.reply(200, public_run(job))
        self.reply(404, {"error": "Unknown peer run"})
