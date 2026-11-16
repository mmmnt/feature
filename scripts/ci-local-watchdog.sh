#!/usr/bin/env bash
# The host rule's cap (founder ruling 2026-11-13, flmnt decision 8ea670d4): a ci-local run lasts at most 30 minutes.
# Started in the background by ci-local; when <seconds> pass with the run still going, it removes the container the
# run is in (named in <current-file>; bash defers a trap until a foreground `docker run` returns, so the container
# must go first), then sends the run SIGTERM, whose trap removes what is left and releases the lock.
#
# usage: scripts/ci-local-watchdog.sh <seconds> <run pid> <current-file>
set -uo pipefail
cap=${1:?seconds}; pid=${2:?run pid}; current=${3:?current file}

# Stopped (the run ended in time): take the sleep down too, so no timer outlives the run and fires on a reused pid.
# The trap goes in before the timer starts, so a stop that lands as soon as the timer exists is never missed.
timer=
trap '[ -z "$timer" ] || kill "$timer" 2>/dev/null; exit 0' TERM INT
sleep "$cap" & timer=$!
wait "$timer"
ps -p "$pid" >/dev/null 2>&1 || exit 0
echo "ci-local: the run passed the ${cap}s cap (host rule 8ea670d4); stopping it" >&2
c=$(cat "$current" 2>/dev/null || true)
[ -z "$c" ] || docker rm -f -v "$c" >/dev/null 2>&1 || true
kill -TERM "$pid" 2>/dev/null || true
exit 0
