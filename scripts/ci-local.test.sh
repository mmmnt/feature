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
  cp "$SRC/scripts/ci-local.sh" "$SRC/scripts/ci-local-plan.mjs" "$SRC/scripts/ci-local.images.json" "$SRC/scripts/docker-sweep.sh" "$R/scripts/"
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
esac
exit 0
STUB
chmod +x "$SW/bin/docker"
sh -c 'exit 0' & DEAD=$!
wait "$DEAD" || true
ALIVE=$$
sweep() { : > "$SW/log"; PATH="$SW/bin:$PATH" SWEEP_LOG="$SW/log" SWEEP_DIR="$SW" bash "$SRC/scripts/docker-sweep.sh" "$@" >/dev/null; }
printf 'feat-kurrent-test-kdb-1\t%s\nfeat-neo4j-test-1\t%s\n' "$DEAD" "$ALIVE" > "$SW/containers"
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
if [ -z "$unowned" ] && [ "$run_sites" -ge 9 ]; then ok "every container a test fixture starts carries the feat-test.owner-pid label ($run_sites calls)"
else bad "every container a test fixture starts carries the feat-test.owner-pid label" "calls read: $run_sites
$unowned"; fi

echo "ci-local.test: $((CASES - FAILS)) passed, $FAILS failed"
[ "$FAILS" = 0 ]
