#!/bin/sh
set -eu

OPERATOR_ACCEPTANCE_FIXTURE_RUN=$(.venv/bin/python -c 'from uuid import uuid4; print(uuid4())')
export OPERATOR_ACCEPTANCE_FIXTURE_RUN
export OPERATOR_ACCEPTANCE_DOCKER=1

cleanup() {
    result=$?
    trap - EXIT
    if fixtures=$(docker container ls -aq --filter "label=swarm.operator.acceptance=$OPERATOR_ACCEPTANCE_FIXTURE_RUN"); then
        for fixture in $fixtures; do
            docker container rm -f "$fixture" >/dev/null || result=1
        done
    else
        result=1
    fi
    exit "$result"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd web
"$@" exec playwright test tests/docker.spec.ts --workers=1
