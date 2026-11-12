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
  cp "$SRC/scripts/ci-local.sh" "$SRC/scripts/ci-local-plan.mjs" "$SRC/scripts/ci-local.images.json" "$R/scripts/"
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

echo "ci-local.test: $((CASES - FAILS)) passed, $FAILS failed"
[ "$FAILS" = 0 ]
