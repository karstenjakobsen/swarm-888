.PHONY: setup lint format test check controller worker
setup:
	uv sync --locked --group dev
lint:
	uv run --locked ruff check .
	uv run --locked ruff format --check .
format:
	uv run --locked ruff format .
test:
	uv run --locked pytest
check: lint test
controller:
	uv run --locked python -m swarm controller
worker:
	uv run --locked python -m swarm worker
