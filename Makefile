PY := .venv/bin/python
RUFF := .venv/bin/ruff
PNPM := corepack pnpm
WEB_PORT ?= 3000
CONTROLLER_PORT ?= 8000
CADDY ?= caddy
export NEXT_TELEMETRY_DISABLED := 1

.PHONY: setup lint format test check web controller worker owner-key gateway api-types check-types build test-live-ui
setup:
	uv sync --locked
	cd web && $(PNPM) install --frozen-lockfile

lint:
	$(RUFF) check .
	$(RUFF) format --check .

format:
	$(RUFF) check --fix .
	$(RUFF) format .

test:
	$(PY) -m pytest -q

api-types:
	$(PY) -m operator_v1.generate_types

check-types:
	$(PY) -m operator_v1.generate_types --check

build:
	cd web && $(PNPM) run build

check: lint test check-types build

web:
	cd web && OPERATOR_MODE=live $(PNPM) run dev --hostname 127.0.0.1 --port $(WEB_PORT)

owner-key:
	$(PY) -m operator_v1.config

controller:
	CONTROLLER_PORT=$(CONTROLLER_PORT) $(PY) -m operator_v1.serve

worker:
	$(PY) -m operator_v1.worker

gateway:
	$(CADDY) run --config Caddyfile --adapter caddyfile

test-live-ui: build
	cd web && $(PNPM) exec playwright test --workers=1

.PHONY: check-fresh
check-fresh:
	sh scripts/check-fresh.sh
