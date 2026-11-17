#!/usr/bin/env bash
# When a ci-local run may use the Docker daemon, under the host rule every gate on this machine keeps (founder
# rulings 2026-11-16, flmnt decision b4e3656a, adopted for Feature 2026-11-17): one gate at a time through a host-wide
# lock, then a real CPU check, start while the daemon's containers use under 12 cores (docker stats, summed). It
# replaces the 15-minute presence wait and the load-average thresholds: on 2026-11-16 a gate waited 1154 s while the
# containers used 0.8 to 4.4 of 16 cores, because presence is not use and a load average lags and counts tasks
# blocked on I/O. The 30-minute cap per run stays (scripts/ci-local-watchdog.sh).
#
# The lock is the file ~/.flmnt/gate.lock, the one flmnt's `cargo xtask ci` takes (xtask/src/hostrule.rs), held with
# the operating system's flock(2), so a Feature gate and a flmnt gate queue behind each other, and a gate that dies
# releases it. A helper process holds it for the run's pid and exits, releasing it, when that pid is gone or on
# `release`. The file names its holder ("pid N in DIR").
#
# usage: scripts/gate-lock.sh acquire <pid>   wait for the lock, hold it for <pid>, then wait for the CPU check
#        scripts/gate-lock.sh release <pid>   give the lock up, if <pid> holds it
# env:   FLMNT_GATE_CPU_MAX (default 12 cores), FLMNT_GATE_LOCK (default ~/.flmnt/gate.lock),
#        CI_LOCAL_LOCK_POLL (default 15 s), CI_LOCAL_LOCK_GIVE_UP (seconds after which to stop waiting, exit 2)
set -uo pipefail

LOCK=${FLMNT_GATE_LOCK:-$HOME/.flmnt/gate.lock}
STATE="${TMPDIR:-/tmp}/feat-gate-lock"
CPU_MAX=${FLMNT_GATE_CPU_MAX:-12}
POLL=${CI_LOCAL_LOCK_POLL:-15}

# The cores the daemon's containers use now, summed from `docker stats` (123.45% is 1.23 cores), or nothing when
# it cannot be read. Unread means wait: the rule never guesses.
cores_in_use() {
  local rows
  rows=$(docker stats --no-stream --format '{{.CPUPerc}}' 2>/dev/null) || return 0
  printf '%s\n' "$rows" | awk '{ gsub(/%/, ""); if ($0 != "") { s += $0; n++ } } END { if (n >= 0) printf "%.2f\n", s / 100 }'
}

under() { awk -v u="$1" -v m="$2" 'BEGIN { exit !(u != "" && u + 0 < m + 0) }'; }

case "${1:-}" in
  acquire)
    pid=${2:?acquire needs a pid}
    mkdir -p "$(dirname "$LOCK")" "$STATE"
    ready="$STATE/$pid.ready"; rm -f "$ready"
    # The helper: open the lock file, say who holds it when it must wait, flock it, write its holder, signal ready,
    # then hold it while <pid> lives. Its own pid is kept so `release` can end it.
    perl -MFcntl=:flock -e '
      $| = 1;
      my ($path, $owner, $ready, $cwd) = @ARGV;
      open(my $f, "+>>", $path) or die "gate-lock: $path: $!\n";
      if (!flock($f, LOCK_EX | LOCK_NB)) {
        open(my $r, "<", $path); my $h = <$r> // "unknown"; chomp $h;
        print "ci-local: another gate holds the lock ($h); waiting for it to end (host rule b4e3656a)\n";
        my $t0 = time; flock($f, LOCK_EX) or die "gate-lock: $!\n";
        printf "ci-local: the gate lock is free after %ds\n", time - $t0;
      }
      truncate($f, 0); seek($f, 0, 0);
      my $old = select($f); $| = 1; select($old);
      print $f "pid $owner in $cwd\n";
      open(my $w, ">", $ready); close $w;
      open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null");
      $SIG{TERM} = sub { exit 0 };
      while (kill(0, $owner)) { sleep 1 }
    ' "$LOCK" "$pid" "$ready" "$(pwd -P)" < /dev/null &
    helper=$!
    echo "$helper" > "$STATE/$pid.helper"
    start=$(date +%s)
    while [ ! -f "$ready" ]; do
      if ! kill -0 "$helper" 2>/dev/null; then echo "ci-local: the gate lock helper exited before taking the lock" >&2; exit 2; fi
      if [ -n "${CI_LOCAL_LOCK_GIVE_UP:-}" ] && [ $(($(date +%s) - start)) -ge "$CI_LOCAL_LOCK_GIVE_UP" ]; then
        kill "$helper" 2>/dev/null; echo "ci-local: gave up after $(($(date +%s) - start))s waiting for the gate lock (CI_LOCAL_LOCK_GIVE_UP)" >&2; exit 2
      fi
      sleep 0.2
    done
    rm -f "$ready"
    said=""
    while true; do
      used=$(cores_in_use)
      if under "$used" "$CPU_MAX"; then
        [ -z "$said" ] || echo "ci-local: starting after $(($(date +%s) - start))s (host rule b4e3656a)"
        exit 0
      fi
      why="the daemon's containers use ${used:-an unreadable number of} cores; waiting for under $CPU_MAX"
      if [ "$why" != "$said" ]; then echo "ci-local: $why (host rule b4e3656a)"; said=$why; fi
      if [ -n "${CI_LOCAL_LOCK_GIVE_UP:-}" ] && [ $(($(date +%s) - start)) -ge "$CI_LOCAL_LOCK_GIVE_UP" ]; then
        echo "ci-local: gave up after $(($(date +%s) - start))s (CI_LOCAL_LOCK_GIVE_UP)" >&2; exit 2
      fi
      sleep "$POLL"
    done
    ;;
  release)
    pid=${2:?release needs a pid}
    f="$STATE/$pid.helper"
    if [ -f "$f" ]; then
      h=$(cat "$f"); kill "$h" 2>/dev/null || true; rm -f "$f"
      for _ in $(seq 1 50); do kill -0 "$h" 2>/dev/null || break; sleep 0.1; done # held until the helper is gone
    fi
    exit 0
    ;;
  *) echo "usage: scripts/gate-lock.sh acquire <pid> | release <pid>" >&2; exit 2 ;;
esac
