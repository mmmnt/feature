#!/usr/bin/env bash
# When a ci-local run may use the Docker daemon, under the host rule every runner sharing it keeps (founder ruling
# 2026-11-13, flmnt decision 8ea670d4): wait for another runner's test container, or another ci-local's lock, at
# most 15 minutes; after that, run anyway only while the 1-minute load average is under 30, else keep waiting.
# One container per runner (ci-local runs its Node versions one after another), and a 30-minute cap per run
# (scripts/ci-local-watchdog.sh).
#
# Why: two runs at once share the daemon's CPU and memory (container start-up past the 120 s hook timeout,
# vitest's worker RPC timing out) and the cache volumes every run mounts (apt refused "Could not get lock
# /var/cache/apt/archives/lock" to the second run). On 2026-11-13 overlapping runs failed suites their commits
# never touched, and back-to-back runs held the load near 80 for two hours.
#
# The lock is a created, never started container named feat-ci-local-lock: a name is unique on a daemon, so
# `docker create --name` takes it or is refused, atomically, for every clone and session sharing the daemon. It
# carries its holder's pid and when it was taken. A holder that is gone (no such pid, or a pid that names a process
# started after the lock was taken) loses it to the next run. A run that proceeds past the wait while another
# holds the lock does so without it.
#
# Another runner's test container: a running container named feat-*-test-* or feat-ci-test-* (Feature's and its
# siblings' test runs), or labelled dev.flmnt.gate.run (flmnt's gate), unless it carries this run's own pid.
#
# usage: scripts/ci-local-lock.sh acquire <pid> <image>   wait as the rule says, then hold the lock for <pid> if free
#        scripts/ci-local-lock.sh release <pid>           give the lock up, if <pid> holds it
# env:   CI_LOCAL_LOCK_WAIT (default 900 s), CI_LOCAL_LOAD_MAX (default 30), CI_LOCAL_LOCK_POLL (default 15 s);
#        CI_LOCAL_LOCK_GIVE_UP: seconds after which to stop waiting and exit 2 (default: never)
set -uo pipefail

NAME=feat-ci-local-lock
OWNER=feat-ci-local.lock-owner
SINCE=feat-ci-local.lock-since
SLACK=5

# Seconds a process has run (ps etime, [[dd-]hh:]mm:ss), or nothing when there is no such process.
elapsed() {
  local t days=0 s=0 part
  t=$(ps -p "$1" -o etime= 2>/dev/null | tr -d ' ') || return 0
  [ -n "$t" ] || return 0
  case "$t" in *-*) days=${t%%-*}; t=${t#*-} ;; esac
  IFS=: read -ra parts <<< "$t"
  for part in "${parts[@]}"; do s=$((s * 60 + 10#$part)); done
  echo $((days * 86400 + s))
}

# Whether the run that took the lock at <since> as <pid> is still that process.
holder_alive() {
  local pid=$1 since=$2 ran now
  ran=$(elapsed "$pid")
  [ -n "$ran" ] || return 1
  now=$(date +%s)
  [ $((now - ran)) -le $((since + SLACK)) ]
}

holder() { docker inspect -f "{{index .Config.Labels \"$OWNER\"}} {{index .Config.Labels \"$SINCE\"}}" "$NAME" 2>/dev/null; }

# The 1-minute load average: macOS's sysctl ("{ 1.23 4.56 7.89 }"), else Linux's /proc/loadavg.
load1() {
  local v
  v=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1}')
  [ -n "$v" ] || v=$(awk '{print $1}' /proc/loadavg 2>/dev/null)
  echo "${v:-0}"
}

# Whether the load is under the rule's ceiling.
load_ok() { awk -v l="$(load1)" -v m="${CI_LOCAL_LOAD_MAX:-30}" 'BEGIN { exit !(l + 0 < m + 0) }'; }

# Other runners' running test containers, by name.
others() {
  local pid=$1
  docker ps --format '{{.Names}}	{{.Label "feat-test.owner-pid"}}	{{.Label "dev.flmnt.gate.run"}}' 2>/dev/null \
    | awk -F '\t' -v me="$pid" '($1 ~ /^feat-.*-test-/ || $1 ~ /^feat-ci-test-/ || $3 != "") && $2 != me { print $1 }'
}

case "${1:-}" in
  acquire)
    pid=${2:?acquire needs a pid}; image=${3:?acquire needs an image}
    wait_max=${CI_LOCAL_LOCK_WAIT:-900}; poll=${CI_LOCAL_LOCK_POLL:-15}; give_up=${CI_LOCAL_LOCK_GIVE_UP:-}
    start=$(date +%s); said=""
    while true; do
      busy=$(others "$pid" | paste -sd ' ' -)
      read -r hpid hsince <<< "$(holder)"
      if [ -n "${hpid:-}" ] && [ "$hpid" != "$pid" ] && ! holder_alive "$hpid" "${hsince:-0}"; then
        echo "ci-local: the lock's holder (pid $hpid) is gone; taking it over"
        docker rm -f -v "$NAME" >/dev/null 2>&1 || true
        continue
      fi
      if [ -z "${hpid:-}" ] && [ -z "$busy" ]; then
        if docker create --name "$NAME" --label "$OWNER=$pid" --label "$SINCE=$(date +%s)" "$image" true >/dev/null 2>&1; then
          exit 0
        fi
        continue # another run took it between the look and the create
      fi
      waited=$(($(date +%s) - start))
      if [ "$waited" -ge "$wait_max" ]; then
        if load_ok; then
          for_what=${busy:-"the lock held by pid ${hpid:-?}"}
          echo "ci-local: waited ${waited}s for ${for_what}; the 1-minute load is $(load1), under ${CI_LOCAL_LOAD_MAX:-30}: running (host rule 8ea670d4)"
          [ -n "${hpid:-}" ] || docker create --name "$NAME" --label "$OWNER=$pid" --label "$SINCE=$(date +%s)" "$image" true >/dev/null 2>&1 || true
          exit 0
        fi
      fi
      what="${busy:+ test containers: $busy}${hpid:+ the lock (pid $hpid)}"
      if [ "$said" != "$what" ]; then
        echo "ci-local: waiting for$what (host rule 8ea670d4: at most ${wait_max}s, then only under load ${CI_LOCAL_LOAD_MAX:-30}; load now $(load1))"
        said=$what
      fi
      if [ -n "$give_up" ] && [ "$waited" -ge "$give_up" ]; then
        echo "ci-local: gave up after ${waited}s (CI_LOCAL_LOCK_GIVE_UP)" >&2
        exit 2
      fi
      sleep "$poll"
    done
    ;;
  release)
    pid=${2:?release needs a pid}
    read -r hpid _ <<< "$(holder)"
    if [ "${hpid:-}" = "$pid" ]; then docker rm -f -v "$NAME" >/dev/null 2>&1 || true; fi
    exit 0
    ;;
  *) echo "usage: scripts/ci-local-lock.sh acquire <pid> <image> | release <pid>" >&2; exit 2 ;;
esac
