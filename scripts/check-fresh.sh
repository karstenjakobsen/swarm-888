#!/bin/sh
set -eu
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git clone --quiet --local --no-hardlinks . "$scratch/checkout"
make -C "$scratch/checkout" setup
make -C "$scratch/checkout" check
