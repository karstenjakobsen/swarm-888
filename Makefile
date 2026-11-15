.PHONY: install init dev worker auth check test build backup restore
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
