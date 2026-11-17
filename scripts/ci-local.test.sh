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
  cp "$SRC/scripts/ci-local.sh" "$SRC/scripts/ci-local-plan.mjs" "$SRC/scripts/ci-local.images.json" "$SRC/scripts/docker-sweep.sh" "$SRC/scripts/gate-lock.sh" "$SRC/scripts/ci-local-watchdog.sh" "$R/scripts/"
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
run "pre-push refuses a commit with no pass record, and runs nothing" 1 "has no full-gate pass record" hook "$LINE"
if (cd "$R" && printf '%s\n' "$LINE" | bash .githooks/pre-push origin x 2>&1) | grep -q "Docker daemon"; then
  bad "pre-push never starts the gate" "it reached the Docker check"
else ok "pre-push never starts the gate"; fi
plant "$(bash "$R/scripts/ci-local.sh" --record-path)"
run "pre-push lets a commit that passed through" 0 "passed the gate" hook "$LINE"
git -C "$R" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m two
TWO=$(git -C "$R" rev-parse HEAD)
run "pre-push refuses when any pushed commit lacks a record" 1 "$TWO has no full-gate pass record" hook "refs/heads/main $TWO refs/heads/main $ZERO"

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

# scripts/gate-lock.sh (host rule b4e3656a): the host-wide flock on a lock file (FLMNT_GATE_LOCK points it into the
# scratch directory) and the CPU check against a `docker stats` stub whose rows come from a file.
GL="$WORK/gatelock"
mkdir -p "$GL/bin"
printf '#!/bin/sh\n[ "$1" = stats ] || exit 0\n[ -e "$GL_DIR/unreadable" ] && exit 1\ncat "$GL_DIR/stats" 2>/dev/null\n' > "$GL/bin/docker"
chmod +x "$GL/bin/docker"
gl() { PATH="$GL/bin:$PATH" GL_DIR="$GL" FLMNT_GATE_LOCK="$GL/gate.lock" TMPDIR="$GL" CI_LOCAL_LOCK_POLL=1 bash "$SRC/scripts/gate-lock.sh" "$@"; }
gl_give_up() { CI_LOCAL_LOCK_GIVE_UP=2 gl "$@"; }
reset_gl() { rm -f "$GL/gate.lock" "$GL/unreadable"; printf '%s\n' "${@:-0.50%}" > "$GL/stats"; }

reset_gl "120.00%" "30.00%"
sleep 300 & H1=$!
run "gate-lock starts at once when the containers use under 12 cores" 0 "" gl acquire "$H1"
if grep -q "^pid $H1 in " "$GL/gate.lock"; then ok "gate-lock names its holder in the lock file"; else bad "gate-lock names its holder in the lock file" "$(cat "$GL/gate.lock")"; fi
sleep 300 & H2=$!
run "gate-lock waits while another gate holds the lock" 2 "another gate holds the lock (pid $H1" gl_give_up acquire $H2
kill "$H1" 2>/dev/null || true; wait "$H1" 2>/dev/null || true
run "gate-lock takes the lock once its holder is gone" 0 "" gl acquire "$H2"
gl release "$H2"; kill "$H2" 2>/dev/null || true; wait "$H2" 2>/dev/null || true
if perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$GL/gate.lock"; then ok "gate-lock release frees the flock"
else bad "gate-lock release frees the flock" "still held"; fi
reset_gl "900.00%" "400.00%"
sleep 300 & H3=$!
run "gate-lock keeps waiting while the containers use 12 cores or more" 2 "use 13.00 cores; waiting for under 12" gl_give_up acquire $H3
gl release "$H3"
reset_gl; touch "$GL/unreadable"
run "gate-lock keeps waiting when docker stats cannot be read" 2 "unreadable number of cores" gl_give_up acquire $H3
gl release "$H3"; kill "$H3" 2>/dev/null || true; wait "$H3" 2>/dev/null || true
run "gate-lock refuses an unknown mode" 2 "usage" bash "$SRC/scripts/gate-lock.sh" nope

# scripts/ci-local-scope.mjs, the scoped check's plan: pure, against a made-up workspace.
scope() { node --input-type=module -e '
  import { scope } from "'"$SRC"'/scripts/ci-local-scope.mjs";
  const pkgs = [
    { name: "@mmmnt/feat-types", dir: "packages/feat-types", deps: new Set() },
    { name: "@mmmnt/feat-runtime", dir: "packages/feat-runtime", deps: new Set(["@mmmnt/feat-types"]) },
    { name: "@mmmnt/feat-adapter-redis", dir: "adapters/redis", deps: new Set(["@mmmnt/feat-types"]) },
    { name: "@mmmnt/feat-adapter-x", dir: "adapters/x", deps: new Set(["@mmmnt/feat-adapter-redis"]) },
    { name: "@mmmnt/feat-adapter-kafka", dir: "adapters/kafka", deps: new Set(["@mmmnt/feat-types"]) },
  ];
  process.stdout.write(JSON.stringify(scope(process.argv.slice(1), pkgs)));' "$@"; }
out=$(scope adapters/redis/src/index.ts)
if [[ "$out" == *'"mode":"scoped"'* && "$out" == *'"@mmmnt/feat-adapter-redis","@mmmnt/feat-adapter-x"]'* && "$out" != *kafka* && "$out" == *'"allSpecs":false'* ]]; then
  ok "scope: a change in one package runs it and its dependents only"; else bad "scope: a change in one package runs it and its dependents only" "$out"; fi
out=$(scope packages/feat-types/src/index.ts)
if [[ "$out" == *'"allSpecs":true'* && "$out" == *'"corpus":true'* && "$out" == *kafka* ]]; then ok "scope: a toolchain package runs every spec and the corpus"
else bad "scope: a toolchain package runs every spec and the corpus" "$out"; fi
for f in pnpm-lock.yaml turbo.json scripts/ci-local.sh .github/workflows/ci.yml schemas/builtspec.schema.json corpus/x.feat docs/grammar-reference.md; do
  out=$(scope adapters/redis/a.ts "$f")
  if [[ "$out" == *'"mode":"full"'* ]]; then ok "scope: $f widens to the full gate"; else bad "scope: $f widens to the full gate" "$out"; fi
done
out=$(scope docs/adr/ADR-0001.md README.md)
if [[ "$out" == *'"mode":"none"'* ]]; then ok "scope: a change only no gate step reads is refused (zero work)"; else bad "scope: a change only no gate step reads is refused (zero work)" "$out"; fi
out=$(scope)
if [[ "$out" == *'"mode":"none"'* ]]; then ok "scope: no change is refused"; else bad "scope: no change is refused" "$out"; fi
out=$(scope somewhere/else.txt)
if [[ "$out" == *'"mode":"full"'* ]]; then ok "scope: a path no rule covers widens to the full gate"; else bad "scope: a path no rule covers widens to the full gate" "$out"; fi

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
# Stop it once its timer runs (its trap is in by then): a stop sent while bash is still starting up is the shell's to
# lose, not the watchdog's, and on a loaded runner that once let the 5s cap fire.
for _ in $(seq 1 50); do pgrep -P "$DOG" -x sleep >/dev/null && break; sleep 0.1; done
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
