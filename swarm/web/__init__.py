"""Assemble static dashboard views. Alpine renders operator data on the client."""

from importlib.resources import files


def index():
    assets = files(__name__)
    views = [
        assets.joinpath("views", name + ".html").read_text()
        for name in ("runs", "brain", "workers", "catalog", "peers")
    ]
    return (
        assets.joinpath("index.html")
        .read_text()
        .replace("<!-- operator-views -->", "\n".join(views))
        .encode()
    )
