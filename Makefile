.PHONY: install init dev worker auth check test build backup restore ops-sync ops-check
install:
	npm ci
init:
	npm run init
dev:
	npm run dev
worker:
	npm run worker
auth:
	npm run auth
check:
	npm run check
test:
	npm test
build:
	npm run build
backup:
	npm run brain:export -- "$(DEST)"
restore:
	npm run brain:restore -- "$(SOURCE)"
ops-sync:
	uv sync --dev
ops-check:
	uv run ruff check ansible
	uv run ruff format --check ansible
	uv run ansible-lint --offline ansible/setup.yml
	uv run ansible-playbook ansible/setup.yml -i localhost, --syntax-check
	uv run python -m unittest discover -s ansible/tests -v
