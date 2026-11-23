PY := .venv/bin/python
RUFF := .venv/bin/ruff
PNPM := corepack pnpm
WEB_PORT ?= 3000
CONTROLLER_PORT ?= 8000
CADDY ?= caddy
NEXT_BUILD_FLAGS ?=
export NEXT_TELEMETRY_DISABLED := 1

.PHONY: setup lint format test check web controller worker owner-key gateway api-types check-types build test-live-ui catalog-init acceptance-docker acceptance-recovery acceptance-catalog
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
	cd web && $(PNPM) run build $(NEXT_BUILD_FLAGS)

check: lint test check-types build

web:
	cd web && OPERATOR_MODE=live $(PNPM) run dev --hostname 127.0.0.1 --port $(WEB_PORT)

owner-key:
	$(PY) -m operator_v1.config

catalog-init:
	$(PY) -m operator_v1.catalog_cli

.PHONY: catalog-pull catalog-push
catalog-pull:
	$(PY) -m operator_v1.catalog_cli pull

catalog-push:
	$(PY) -m operator_v1.catalog_cli push

controller:
	CONTROLLER_PORT=$(CONTROLLER_PORT) $(PY) -m operator_v1.serve

worker:
	$(PY) -m operator_v1.worker

gateway:
	$(CADDY) run --config Caddyfile --adapter caddyfile

test-live-ui: build
	cd web && $(PNPM) exec playwright test --workers=1

acceptance-docker: build
	CADDY="$(CADDY)" sh scripts/acceptance-docker.sh $(PNPM)

acceptance-recovery:
	OPERATOR_ACCEPTANCE_DOCKER=1 $(PY) -m pytest -q -s tests/test_operations.py

acceptance-catalog: build
	cd web && CADDY="$(CADDY)" $(PNPM) exec playwright test tests/catalog.spec.ts --workers=1

.PHONY: backup restore
backup:
	$(PY) -m operator_v1.backup export "$(OPERATOR_BACKUP)"

restore:
	$(PY) -m operator_v1.backup restore "$(OPERATOR_BACKUP)" $(if $(OPERATOR_RESTORE_CATALOG),--catalog-checkout "$(OPERATOR_RESTORE_CATALOG)")

.PHONY: check-fresh
check-fresh:
	sh scripts/check-fresh.sh
