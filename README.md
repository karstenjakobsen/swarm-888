# Single-host VPS operator

The private UI can accept an owner message, show its worker acknowledgment and replay its timeline. The worker currently acknowledges receipt. Skill authoring starts in slice 3.

## Run on WSL2

Use Python 3.12 or newer, uv, Node.js 24 with Corepack, and Make. Running the private origin also requires Caddy 2 on your PATH, or an absolute executable path in `CADDY`. Run the services as your ordinary user.

```sh
make setup
make check
make owner-key
```

`make owner-key` creates a private owner key once and prints the file path. The default state directory is `~/.local/state/vps-operator`. To use another location, export `OPERATOR_STATE_DIR` in each terminal before initialization. Choose a private directory outside the source tree. SQLite stores the operator profile, task checkpoints, messages, ordered events and hashed sessions there. The directory also holds the worker socket and key. On first initialization, `OPERATOR_NAME`, `OPERATOR_PURPOSE` and `OPERATOR_INSTRUCTIONS` set the persisted profile.

Start each foreground service in its own terminal using the same configuration.

| Command | Service |
| --- | --- |
| `make controller` | FastAPI on loopback port 8000 |
| `make worker` | Message worker listening on the private Unix socket |
| `make web` | Next.js in live mode on loopback port 3000 |
| `make gateway` | Caddy on loopback port 8080 |

Open [the private UI](http://127.0.0.1:8080), sign in with the key from the file, and submit a message. Open the task from the brief to see its timeline. An offline worker leaves the task queued. Starting it picks up the saved message. A controller outage shows an unavailable state and the browser reconnects when the controller returns.

If a submission loses its receipt, retry the same text in the same tab. The browser keeps the request ID across reloads when session storage is available. The controller returns the original task for a matching retry. Once the receipt arrives, sending the same text again starts a new task.

Caddy sends `/api/*` directly to FastAPI. The session cookie is HTTP-only and scoped to `/api`. Browser writes require the configured origin and a custom request header. If you change the gateway port, set both `OPERATOR_PORT` and `OPERATOR_ORIGIN` (for example, `http://127.0.0.1:8081`). `WEB_PORT` and `CONTROLLER_PORT` configure the upstream ports.

## Demo and verification

To run the public fixture UI locally, use `cd web && OPERATOR_MODE=demo corepack pnpm run dev --hostname 127.0.0.1` and open its port directly. The demo supports its placeholder credential and modeled DNS/TLS examples. The server selects the mode.

- `make check` checks Ruff lint and formatting, runs pytest with temporary state, checks generated API types, builds Next.js and typechecks the UI. The locked font packages supply IBM Plex at build time.
- `make format` applies Ruff formatting and fixes. After a backend contract change, regenerate the frontend types with `make api-types`.
- `make check-fresh` clones the current local commit into a temporary directory, then runs `make setup` and `make check` there.
- `make test-live-ui` runs Playwright against the production UI, a real loopback Caddy origin, FastAPI and a separate worker using disposable state. Install the test browser once with `cd web && corepack pnpm exec playwright install chromium`. The browser check covers owner sign-in, task submission, unauthorized and cross-origin requests, a controller outage during a queued task, stream catch-up and reload.
