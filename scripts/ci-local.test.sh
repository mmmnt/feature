#!/usr/bin/env bash
# Tests of ci-local's pass record (--record-path, --skip-passed) and of .githooks/pre-push using it. Each case
# runs in a scratch clone holding a copy of the runner, with a `docker` stub on the PATH that fails: a case that
# would run the jobs stops at "the Docker daemon is not reachable" (exit 2), so a skip shows as exit 0 and no
# job ever starts. Run by CI's check job; `bash scripts/ci-local.test.sh` runs it locally.
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ci-local-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

FAILS=0
CASES=0
ok() { CASES=$((CASES + 1)); echo "ok   $1"; }
bad() { CASES=$((CASES + 1)); FAILS=$((FAILS + 1)); echo "FAIL $1"; echo "$2" | sed 's/^/     /'; }

# A fresh clone with the runner and the hook committed, as the repository has them.
fresh() {
  R="$WORK/repo-$CASES"
  rm -rf "$R"
  mkdir -p "$R/scripts" "$R/.githooks"
  cp "$SRC/scripts/ci-local.sh" "$SRC/scripts/ci-local-plan.mjs" "$SRC/scripts/ci-local.images.json" "$SRC/scripts/docker-sweep.sh" "$SRC/scripts/ci-local-lock.sh" "$SRC/scripts/ci-local-watchdog.sh" "$R/scripts/"
  cp "$SRC/.githooks/pre-push" "$R/.githooks/"
  git -C "$R" init -q
  git -C "$R" -c user.name=t -c user.email=t@example.invalid add -A
  git -C "$R" -c user.name=t -c user.email=t@example.invalid commit -q -m one
}
plant() { mkdir -p "$(dirname "$1")"; printf '3 passed at 2026-01-01T00:00:00Z\n' > "$1"; }
# run <description> <expected rc> <expected output fragment> <command...>
run() {
  local name=$1 want=$2 frag=$3 out rc
  shift 3
  if out=$("$@" 2>&1); then rc=0; else rc=$?; fi
  if [ "$rc" = "$want" ] && { [ -z "$frag" ] || [[ "$out" == *"$frag"* ]]; }; then ok "$name"
  else bad "$name" "want rc $want and \"$frag\", got rc $rc: $out"; fi
}

fresh
SHA=$(git -C "$R" rev-parse HEAD)
REC=$(bash "$R/scripts/ci-local.sh" --record-path)
GITDIR=$(cd "$R/.git" && pwd -P)
if [[ "$REC" =~ ^$GITDIR/feat-ci-local/passed/$SHA-[0-9a-f]{16}$ ]]; then ok "--record-path names <git dir>/feat-ci-local/passed/<commit>-<runner>"
else bad "--record-path names <git dir>/feat-ci-local/passed/<commit>-<runner>" "$REC"; fi

fresh
run "--skip-passed with no record runs the jobs" 2 "Docker daemon is not reachable" bash "$R/scripts/ci-local.sh" --skip-passed

fresh
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
run "--skip-passed with a record skips" 0 "already passed (3 passed at 2026-01-01T00:00:00Z), not run again" \
  bash "$R/scripts/ci-local.sh" --skip-passed

fresh
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
run "a record without --skip-passed still runs" 2 "Docker daemon is not reachable" bash "$R/scripts/ci-local.sh"

fresh
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
echo ' ' >> "$R/scripts/ci-local.images.json"
run "a changed runner makes the record stale" 2 "Docker daemon is not reachable" bash "$R/scripts/ci-local.sh" --skip-passed

fresh
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
FIRST=$(git -C "$R" rev-parse HEAD)
git -C "$R" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m two
run "another commit's record does not count" 2 "Docker daemon is not reachable" bash "$R/scripts/ci-local.sh" --skip-passed
run "--ref picks the commit the record is for" 0 "already passed" bash "$R/scripts/ci-local.sh" --skip-passed --ref "$FIRST"

fresh
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
for f in "--job check" "--node 24" "--all"; do
  # shellcheck disable=SC2086
  run "--skip-passed is refused with $f" 2 "--skip-passed applies to the default selection only" \
    bash "$R/scripts/ci-local.sh" --skip-passed $f
done

fresh
SHA=$(git -C "$R" rev-parse HEAD)
ZERO=0000000000000000000000000000000000000000
LINE="refs/tags/v1 $SHA refs/tags/v1 $ZERO"
hook() { (cd "$R" && printf '%s\n' "$1" | bash .githooks/pre-push origin git@example.invalid:x.git); }
run "pre-push runs a commit with no record" 2 "Docker daemon is not reachable" hook "$LINE"
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
run "pre-push lets a commit that passed through" 0 "not run again" hook "$LINE"

# scripts/docker-sweep.sh against a recording `docker` stub: listings come from files, every call is logged.
SW="$WORK/sweep"
mkdir -p "$SW/bin"
cat > "$SW/bin/docker" <<'STUB'
#!/bin/sh
echo "$*" >> "$SWEEP_LOG"
case "$1 $2" in
  "ps -a") cat "$SWEEP_DIR/containers" ;;
  "network ls") cat "$SWEEP_DIR/networks" ;;
  "volume ls") cat "$SWEEP_DIR/volumes" ;;
  "inspect -f")
    # a container named in $SWEEP_DIR/running runs; any other does not exist
    if grep -qx "$4" "$SWEEP_DIR/running" 2>/dev/null; then echo true; else exit 1; fi ;;
esac
exit 0
STUB
chmod +x "$SW/bin/docker"
sh -c 'exit 0' & DEAD=$!
wait "$DEAD" || true
ALIVE=$$
sweep() { : > "$SW/log"; PATH="$SW/bin:$PATH" SWEEP_LOG="$SW/log" SWEEP_DIR="$SW" bash "$SRC/scripts/docker-sweep.sh" "$@" >/dev/null; }
printf 'feat-kurrent-test-kdb-1\t%s\nfeat-neo4j-test-1\t%s\n' "$DEAD" "$ALIVE" > "$SW/containers"
: > "$SW/running"
printf 'feat-test-net-1\t%s\n' "$DEAD" > "$SW/networks"
printf 'feat-test-vol-1\t%s\nfeat-test-vol-2\t%s\n' "$ALIVE" "$DEAD" > "$SW/volumes"

sweep --gone
if grep -qx "rm -f -v feat-kurrent-test-kdb-1" "$SW/log" && ! grep -q "feat-neo4j-test-1" "$SW/log" \
  && grep -qx "network rm feat-test-net-1" "$SW/log" && grep -qx "volume rm -f feat-test-vol-2" "$SW/log" \
  && ! grep -q "feat-test-vol-1" "$SW/log"; then
  ok "docker-sweep --gone removes, with their volumes, what a dead run left and keeps a live run's"
else bad "docker-sweep --gone removes, with their volumes, what a dead run left and keeps a live run's" "$(cat "$SW/log")"; fi

sweep --run "$ALIVE"
if grep -qx "rm -f -v feat-neo4j-test-1" "$SW/log" && grep -qx "volume rm -f feat-test-vol-1" "$SW/log" \
  && ! grep -q "kdb-1\|net-1\|vol-2" "$SW/log"; then ok "docker-sweep --run <pid> removes that run's objects only"
else bad "docker-sweep --run <pid> removes that run's objects only" "$(cat "$SW/log")"; fi

sweep --gone
unscoped=$(grep -E '^(ps|network ls|volume ls)' "$SW/log" | grep -v -- '--filter label=feat-test.owner-pid' || true)
pruned=$(grep -E 'prune' "$SW/log" || true)
if [ -z "$unscoped$pruned" ] && [ "$(grep -cE '^(ps|network ls|volume ls)' "$SW/log")" = 3 ]; then
  ok "docker-sweep lists by its label only and never prunes"
else bad "docker-sweep lists by its label only and never prunes" "$(cat "$SW/log")"; fi

run "docker-sweep refuses an unknown mode" 2 "usage" bash "$SRC/scripts/docker-sweep.sh" --everything

# An owner inside a container (ci-local's job container, a person's own): its pid is the container's, which the host
# cannot see, so the container decides. A live run's test container must survive a concurrent run's --gone sweep.
printf 'feat-kafka-test-b1-1\t%s\tfeat-ci-test-node24-live\nfeat-kafka-test-b1-2\t%s\tfeat-ci-test-node24-gone\n' "$DEAD" "$ALIVE" > "$SW/containers"
: > "$SW/networks"; : > "$SW/volumes"
echo feat-ci-test-node24-live > "$SW/running"
sweep --gone
if ! grep -q "feat-kafka-test-b1-1" "$SW/log" && grep -qx "rm -f -v feat-kafka-test-b1-2" "$SW/log"; then
  ok "docker-sweep --gone keeps what a running owner container started and removes what a gone one did, whatever the pid"
else bad "docker-sweep --gone keeps what a running owner container started and removes what a gone one did, whatever the pid" "$(cat "$SW/log")"; fi

# A pid this user may not signal (pid 1) is alive: kill -0 answers EPERM there, which must not read as gone.
printf 'feat-neo4j-test-db-1\t1\t\n' > "$SW/containers"
: > "$SW/running"
sweep --gone
if ! grep -q "feat-neo4j-test-db-1" "$SW/log"; then ok "docker-sweep --gone counts a process it may not signal as alive"
else bad "docker-sweep --gone counts a process it may not signal as alive" "$(cat "$SW/log")"; fi

# scripts/ci-local-lock.sh (host rule 8ea670d4) against stubs: `docker`'s lock is a file (create is refused while it
# exists), its running containers come from a file, and `sysctl` answers the load a file holds.
LK="$WORK/lock"
mkdir -p "$LK/bin"
cat > "$LK/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  create)
    [ -e "$LOCK_FILE" ] && exit 1
    owner=""; since=""
    while [ $# -gt 0 ]; do
      case "$1" in --label) case "$2" in feat-ci-local.lock-owner=*) owner=${2#*=} ;; feat-ci-local.lock-since=*) since=${2#*=} ;; esac; shift ;; esac
      shift
    done
    echo "$owner $since" > "$LOCK_FILE" ;;
  inspect) [ -e "$LOCK_FILE" ] && cat "$LOCK_FILE" || exit 1 ;;
  rm) echo "rm $*" >> "$LOCK_DIR/log"; rm -f "$LOCK_FILE" ;;
  ps) cat "$LOCK_DIR/running" 2>/dev/null ;;
  run) echo "run $*" >> "$LOCK_DIR/vmlog"; [ -e "$LOCK_DIR/vmload" ] && echo "$(cat "$LOCK_DIR/vmload") 1.00 1.00 1/100 1" ;;
esac
exit 0
STUB
printf '#!/bin/sh\necho "{ $(cat "$LOCK_DIR/load") 1.00 1.00 }"\n' > "$LK/bin/sysctl"
chmod +x "$LK/bin/docker" "$LK/bin/sysctl"
# lock <wait> <give up> <args...>
lock() {
  local w=$1 g=$2; shift 2
  PATH="$LK/bin:$PATH" LOCK_DIR="$LK" LOCK_FILE="$LK/held" CI_LOCAL_LOCK_WAIT=$w CI_LOCAL_LOCK_GIVE_UP=$g CI_LOCAL_LOCK_POLL=1 \
    bash "$SRC/scripts/ci-local-lock.sh" "$@"
}
reset_lock() { rm -f "$LK/held" "$LK/log" "$LK/vmlog"; : > "$LK/running"; echo "${1:-1.5}" > "$LK/load"; echo "${2:-1.5}" > "$LK/vmload"; }

reset_lock
run "ci-local-lock takes a free lock on an idle daemon" 0 "" lock 900 0 acquire "$ALIVE" img
if [ "$(cut -d' ' -f1 "$LK/held")" = "$ALIVE" ]; then ok "ci-local-lock records its holder's pid"; else bad "ci-local-lock records its holder's pid" "$(cat "$LK/held")"; fi

reset_lock 1.5
printf 'feat-kurrent-test-kdb-9\t999999\t\n' > "$LK/running"
run "ci-local-lock waits for another runner's test container, however low the load, until the wait is up" 2 "waiting for test containers: feat-kurrent-test-kdb-9" lock 900 0 acquire "$ALIVE" img
reset_lock 1.5
printf 'great_burnell\t\t12345x1700000000\n' > "$LK/running"
run "ci-local-lock counts a flmnt gate (dev.flmnt.gate.run) as another runner" 2 "waiting for test containers: great_burnell" lock 900 0 acquire "$ALIVE" img
reset_lock 1.5
printf 'feat-kafka-test-b1-9\t%s\t\n' "$ALIVE" > "$LK/running"
run "ci-local-lock does not wait for its own run's containers" 0 "" lock 900 0 acquire "$ALIVE" img

reset_lock 45.2
echo "999999 $(date +%s)" > "$LK/held"
printf 'feat-ci-test-node24-x\t999999\t\n' > "$LK/running"
run "ci-local-lock keeps waiting past the wait while the 1-minute load is 30 or more" 2 "gave up" lock 0 0 acquire "$ALIVE" img
reset_lock 12.0
echo "$ALIVE $(date +%s)" > "$LK/held.other"
printf 'feat-ci-test-node24-x\t999999\t\n' > "$LK/running"
run "ci-local-lock runs past the wait once the 1-minute load is under 30" 0 "under 30: running (host rule 8ea670d4)" lock 0 0 acquire "$ALIVE" img
if grep -q 'run --rm --network none --label feat-test.owner-pid='"$ALIVE"' img cat /proc/loadavg' "$LK/vmlog" 2>/dev/null; then ok "ci-local-lock reads the Docker VM's load through a labelled throwaway container"
else bad "ci-local-lock reads the Docker VM's load through a labelled throwaway container" "$(cat "$LK/vmlog" 2>/dev/null)"; fi
reset_lock 12.0 45.0
echo "999999 $(date +%s)" > "$LK/held"
printf 'feat-ci-test-node24-x\t999999\t\n' > "$LK/running"
run "ci-local-lock keeps waiting while the Docker VM's load is 30 or more, however low the host's" 2 "gave up" lock 0 0 acquire "$ALIVE" img
reset_lock 12.0
rm -f "$LK/vmload"
echo "999999 $(date +%s)" > "$LK/held"
printf 'feat-ci-test-node24-x\t999999\t\n' > "$LK/running"
run "ci-local-lock keeps waiting when the Docker VM's load cannot be read" 2 "gave up" lock 0 0 acquire "$ALIVE" img
reset_lock 12.0 45.0
echo "999999 $(date +%s)" > "$LK/held"
printf 'feat-ci-test-node24-x\t999999\t\n' > "$LK/running"
PATH="$LK/bin:$PATH" LOCK_DIR="$LK" LOCK_FILE="$LK/held" CI_LOCAL_LOCK_WAIT=0 CI_LOCAL_LOCK_GIVE_UP=3 CI_LOCAL_LOCK_POLL=1 bash "$SRC/scripts/ci-local-lock.sh" acquire "$ALIVE" img >/dev/null 2>&1 || true
reads=$(grep -c ' cat /proc/loadavg' "$LK/vmlog" 2>/dev/null || echo 0)
if [ "$reads" -eq 1 ]; then ok "ci-local-lock reads the Docker VM's load at most once a minute"
else bad "ci-local-lock reads the Docker VM's load at most once a minute" "$reads reads in ~3 s"; fi

reset_lock
echo "$DEAD $(date +%s)" > "$LK/held"
run "ci-local-lock takes over from a holder that is gone" 0 "is gone; taking it over" lock 900 0 acquire "$ALIVE" img
reset_lock
echo "$ALIVE $(( $(date +%s) - 86400 ))" > "$LK/held"
run "ci-local-lock takes over from a reused pid (started after the lock was taken)" 0 "is gone; taking it over" lock 900 0 acquire 999998 img
reset_lock
echo "$ALIVE $(date +%s)" > "$LK/held"
run "ci-local-lock release by another pid keeps the lock" 0 "" lock 900 0 release 999999
if [ -e "$LK/held" ]; then ok "ci-local-lock is released only by its holder"; else bad "ci-local-lock is released only by its holder" "lock gone"; fi
run "ci-local-lock release by its holder frees it" 0 "" lock 900 0 release "$ALIVE"
if [ ! -e "$LK/held" ]; then ok "ci-local-lock leaves no lock after release"; else bad "ci-local-lock leaves no lock after release" "$(cat "$LK/held")"; fi
run "ci-local-lock refuses an unknown mode" 2 "usage" bash "$SRC/scripts/ci-local-lock.sh" --everything

# scripts/ci-local-watchdog.sh: past the cap it removes the run's container, then stops the run; stopped in time,
# it does neither.
WD="$WORK/watchdog"
mkdir -p "$WD/bin"
printf '#!/bin/sh\necho "$*" >> "%s/log"\nexit 0\n' "$WD" > "$WD/bin/docker"
chmod +x "$WD/bin/docker"
echo feat-ci-test-node24-run > "$WD/current"
: > "$WD/log"
sleep 30 & VICTIM=$!
PATH="$WD/bin:$PATH" bash "$SRC/scripts/ci-local-watchdog.sh" 1 "$VICTIM" "$WD/current" 2>/dev/null
if wait "$VICTIM" 2>/dev/null; then vrc=0; else vrc=$?; fi
if grep -qx "rm -f -v feat-ci-test-node24-run" "$WD/log" && [ "$vrc" -ne 0 ]; then
  ok "ci-local-watchdog removes the run's container and stops the run past the cap"
else bad "ci-local-watchdog removes the run's container and stops the run past the cap" "rc $vrc; $(cat "$WD/log")"; fi
: > "$WD/log"
sleep 30 & VICTIM=$!
PATH="$WD/bin:$PATH" bash "$SRC/scripts/ci-local-watchdog.sh" 5 "$VICTIM" "$WD/current" & DOG=$!
kill "$DOG"; wait "$DOG" 2>/dev/null || true
if ps -p "$VICTIM" >/dev/null 2>&1 && [ ! -s "$WD/log" ]; then ok "ci-local-watchdog stopped in time removes nothing and stops nothing"
else bad "ci-local-watchdog stopped in time removes nothing and stops nothing" "$(cat "$WD/log")"; fi
kill "$VICTIM" 2>/dev/null; wait "$VICTIM" 2>/dev/null || true

# scripts/test-owner.mjs: the labels a fixture's containers carry, on a host and inside a container.
owner_out=$(node --input-type=module -e '
  const { ownerArgs } = await import(process.argv[1]);
  const id = "a".repeat(64);
  const none = () => "";
  const cases = {
    host: ownerArgs({}, none, 42),
    ciLocal: ownerArgs({ FEAT_CI_LOCAL_PID: "7", FEAT_CI_LOCAL_CONTAINER: "feat-ci-test-node24-x" }, none, 42),
    ownContainer: ownerArgs({}, () => `1 2 0:1 /docker/containers/${id}/hostname /etc/hostname rw - ext4`, 42),
  };
  console.log(JSON.stringify(cases));
' "$SRC/scripts/test-owner.mjs" 2>&1)
want_owner='{"host":["--label","feat-test.owner-pid=42"],"ciLocal":["--label","feat-test.owner-pid=7","--label","feat-test.owner-container=feat-ci-test-node24-x"],"ownContainer":["--label","feat-test.owner-pid=42","--label","feat-test.owner-container=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}'
if [ "$owner_out" = "$want_owner" ]; then ok "test-owner labels the owner pid, and the owner container when it runs in one"
else bad "test-owner labels the owner pid, and the owner container when it runs in one" "$owner_out"; fi


# The two sweeps below read the tree itself, not git: ci-local checks a `git archive`, which has no .git. Each also
# counts what it read, so a sweep that finds no call site at all fails instead of passing on zero work.
# sources [fixtures]: the files to read; with `fixtures`, without the packages' product code (<group>/<pkg>/src).
# Paths are pruned relative to $SRC: ci-local extracts the tree into a directory that is itself named src.
sources() {
  local product=(-false)
  [ "${1:-}" = fixtures ] && product=(-path "$SRC/adapters/*/src" -o -path "$SRC/packages/*/src")
  find "$SRC/adapters" "$SRC/packages" "$SRC/scripts" \( -name node_modules -o -name dist -o -name .feature -o -name coverage \
    -o "${product[@]}" \) -prune -o -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.ts' -o -name '*.sh' \) \
    ! -name ci-local.test.sh -print
}

# A container started from an image that declares VOLUME leaves an anonymous volume behind unless it is removed
# with -v (664 KurrentDB and Neo4j volumes had piled up). Every `docker rm` in the repository passes it.
rm_scan=$(sources | while read -r f; do
  perl -ne 'if (/"rm",\s*+"-f",|\bdocker rm /) { print "SITE\n"; print "$ARGV:$.: $_" if /"rm",\s*+"-f",\s*+(?!"-v")|\bdocker rm (?!-f -v)/ } close ARGV if eof' "$f"
done)
rm_sites=$(printf '%s\n' "$rm_scan" | grep -c '^SITE$' || true)
missing=$(printf '%s\n' "$rm_scan" | grep -v '^SITE$' | sed '/^$/d' || true)
if [ -z "$missing" ] && [ "$rm_sites" -ge 10 ]; then ok "every docker rm in the repository removes the container's anonymous volumes (-v) ($rm_sites sites)"
else bad "every docker rm in the repository removes the container's anonymous volumes (-v)" "sites read: $rm_sites
$missing"; fi

# Every container a test fixture starts carries the owner label the sweep removes by (product code under src/ is
# not a test fixture). A docker run or create spread over several lines is read as one call.
run_scan=$(sources fixtures | while read -r f; do
  perl -0ne 'while (/\[\s*"(?:run|create)",([^\]]*)\]/g) { my ($m, $a) = ($&, $1); next unless $a =~ /"--name"/; print "SITE\n"; print "$ARGV: $m\n" if $a !~ /\.\.\.OWNER/ }' "$f"
done)
run_sites=$(printf '%s\n' "$run_scan" | grep -c '^SITE$' || true)
unowned=$(printf '%s\n' "$run_scan" | grep -v '^SITE$' | sed '/^$/d' || true)
inline=$(sources fixtures | grep -v '/scripts/test-owner.mjs$' | xargs grep -ln 'const OWNER *=' 2>/dev/null || true)
[ -z "$inline" ] || unowned="$unowned
OWNER defined inline instead of imported from scripts/test-owner.mjs: $inline"
if [ -z "$unowned" ] && [ "$run_sites" -ge 9 ]; then ok "every container a test fixture starts carries the feat-test.owner-pid label ($run_sites calls)"
else bad "every container a test fixture starts carries the feat-test.owner-pid label" "calls read: $run_sites
$unowned"; fi

# No test process makes a synchronous docker call: one stops the worker's event loop, and one that outlasts vitest's
# 60 s worker RPC timeout (a peer client's npm install in a container, an image pull) ends the run with "Timeout
# calling onTaskUpdate", every test passed. The one exception is the exit-time cleanup (process.once("exit")), which
# cannot await: `spawnSync("docker", ["rm", "-f", "-v", ...names]` with the names it created. Counted, so a scan that
# reads no call site fails.
sync_scan=$(sources fixtures | while read -r f; do
  perl -0ne 'while (/\b(?:execFileSync|spawnSync|execSync)\(\s*"docker"([^;]*)/g) { my $a = $1; print "SITE\n"; print "$ARGV: $&\n" unless $a =~ /^\s*,\s*\["rm", "-f", "-v", \.\.\.names\]/ }' "$f"
done)
sync_sites=$(printf '%s\n' "$sync_scan" | grep -c '^SITE$' || true)
blocking=$(printf '%s\n' "$sync_scan" | grep -v '^SITE$' | sed '/^$/d' || true)
async_sites=$(sources fixtures | xargs grep -ho -E '\bdockerAsync\(|execFile\("docker"' 2>/dev/null | wc -l | tr -d ' ')
if [ -z "$blocking" ] && [ "$sync_sites" -ge 6 ] && [ "$async_sites" -ge 6 ]; then
  ok "no test process makes a synchronous docker call but its exit-time cleanup ($sync_sites cleanups, $async_sites asynchronous calls)"
else bad "no test process makes a synchronous docker call but its exit-time cleanup" "cleanups read: $sync_sites, asynchronous calls: $async_sites
$blocking"; fi

# ci-local runs its job container with the parallelism of the runner it stands in for. Vitest gives a pool
# availableParallelism - 1 workers: 3 on a 4-vCPU ubuntu-latest runner, 15 in a 16-CPU Docker Desktop VM. Measured on
# 2026-11-14 inside ci-local's container, 15 workers beside the ~30 product containers their specs start were
# descheduled 20-54 s at a time (feat-core/parse.test.ts, whose file runs in 3 s alone), their IPC to vitest's main
# process queued behind them, and past 60 s a worker's RPC timed out ("Timeout calling onTaskUpdate", every test
# passed). The job container gets VITEST_MAX_FORKS and VITEST_MAX_THREADS (default 3, CI_LOCAL_MAX_WORKERS).
if grep -q -- '-e VITEST_MAX_FORKS="$MAX_WORKERS" -e VITEST_MAX_THREADS="$MAX_WORKERS"' "$SRC/scripts/ci-local.sh" \
  && grep -q '^MAX_WORKERS=${CI_LOCAL_MAX_WORKERS:-3}$' "$SRC/scripts/ci-local.sh"; then
  ok "ci-local gives its job container the runner's vitest parallelism (3 workers, CI_LOCAL_MAX_WORKERS)"
else bad "ci-local gives its job container the runner's vitest parallelism (3 workers, CI_LOCAL_MAX_WORKERS)" "no VITEST_MAX_FORKS/THREADS from MAX_WORKERS in scripts/ci-local.sh"; fi

echo "ci-local.test: $((CASES - FAILS)) passed, $FAILS failed"
[ "$FAILS" = 0 ]
