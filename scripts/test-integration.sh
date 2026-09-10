#!/usr/bin/env bash
# Runs the DB-backed test suite (test/integration/) against a throwaway
# "scratchtest" database on the dev Postgres container, so a run can never
# touch real local data. Needs `docker compose up -d` and a filled-in .env
# (STRIPE_SECRET_KEY specifically — see test/integration/test.env).
set -euo pipefail

PSQL="docker exec fullapi-db-1 psql -U bandera -d bandera -v ON_ERROR_STOP=1 -q"

cleanup() { $PSQL -c 'DROP DATABASE IF EXISTS scratchtest;' >/dev/null; }
trap cleanup EXIT

$PSQL -c 'DROP DATABASE IF EXISTS scratchtest;' >/dev/null
$PSQL -c 'CREATE DATABASE scratchtest;' >/dev/null

node --env-file=.env --env-file=test/integration/test.env --test test/integration/*.test.ts
