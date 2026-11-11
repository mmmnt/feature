#!/usr/bin/env bash
# Run the ubuntu jobs of .github/workflows/ci.yml locally, one at a time, each in a throwaway Linux container.
#
# The jobs are not listed here: scripts/ci-local-plan.mjs reads ci.yml from the commit being checked, expands
# each job's matrix, evaluates the steps' `if:` and writes the `run:` steps as a driver script. A job CI runs
# on another OS is printed as a GAP line, left to CI.
#
# Each job gets a fresh `git archive` of the commit under $CI_LOCAL_DIR, mounted at the same absolute path in
# the container, so a path a test hands the Docker daemon (a bind mount of its tree, or of $TMPDIR, which points
# inside the job's directory) resolves to the same files. The container has the docker CLI and the host's
# socket, and runs on the host network, so the product containers a test starts are reached on 127.0.0.1 at
# their published ports, as on a GitHub runner.
#
# usage: scripts/ci-local.sh [--ref <commit>] [--job <id|name>]... [--node <major>]... [--keep] [--list]
#   --ref   the commit to check (default HEAD); uncommitted changes are never part of the run
#   --job   a job id from ci.yml (check, test, spec) or the start of its name; repeatable
#   --node  a matrix Node major (20, 22, 24, 26); repeatable
#   --keep  keep each job's tree after the run (default: removed, the logs stay)
#   --list  print the jobs the filters select and exit
# env: CI_LOCAL_DIR  where runs go (default ${TMPDIR:-/tmp}/feat-ci-local); Docker Desktop must share it
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REF=HEAD
KEEP=0
LIST=0
FILTERS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=${2:?--ref needs a commit}; shift 2 ;;
    --job) FILTERS+=(--job "${2:?--job needs a name}"); shift 2 ;;
    --node) FILTERS+=(--node "${2:?--node needs a major}"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ci-local: unknown option $1" >&2; exit 2 ;;
  esac
done

for tool in git node docker tar; do
  command -v "$tool" >/dev/null || { echo "ci-local: $tool is not on PATH" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "ci-local: the Docker daemon is not reachable" >&2; exit 2; }

# A run killed outright (SIGKILL) cannot remove its job container. Each one carries the runner's pid, so a later
# run removes those whose runner is gone.
for c in $(docker ps -a --filter label=feat-ci-local.pid --format '{{.Names}}'); do
  owner=$(docker inspect -f '{{index .Config.Labels "feat-ci-local.pid"}}' "$c" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    echo "ci-local: removing $c, left by a run that is gone"
    docker rm -f "$c" >/dev/null 2>&1 || true
  fi
done

SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
BASE=${CI_LOCAL_DIR:-${TMPDIR:-/tmp}/feat-ci-local}
mkdir -p "$BASE"
BASE=$(cd "$BASE" && pwd -P)
ID=$(date +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
RUN="$BASE/run-$ID"
STORE="$BASE/pnpm-store" # shared across runs, as CI's setup-node `cache: pnpm` restores the store
mkdir -p "$RUN/tree" "$STORE"

CURRENT=""
JOBDIRS=()
cleanup() {
  local rc=$?
  if [ -n "$CURRENT" ]; then docker rm -f "$CURRENT" >/dev/null 2>&1 || true; fi
  if [ "$KEEP" = 0 ] && [ "${#JOBDIRS[@]}" -gt 0 ]; then
    for d in "${JOBDIRS[@]}"; do rm -rf "$d/src" "$d/tmp" 2>/dev/null || echo "ci-local: could not remove $d" >&2; done
  fi
  rm -f "$RUN/source.tar"
  if [ "$LIST" = 1 ]; then rm -rf "$RUN"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$REPO" archive --format=tar -o "$RUN/source.tar" "$SHA"
tar -xf "$RUN/source.tar" -C "$RUN/tree" .github/workflows/ci.yml package.json

node "$REPO/scripts/ci-local-plan.mjs" \
  --workflow "$RUN/tree/.github/workflows/ci.yml" --package "$RUN/tree/package.json" \
  --images "$REPO/scripts/ci-local.images.json" --out "$RUN/plan" ${FILTERS[@]+"${FILTERS[@]}"} > "$RUN/plan.tsv"

KIND=(); KEY=(); NODE=(); IMAGE=(); NAME=(); DRIVER=()
while IFS=$'\t' read -r kind key a b c d; do
  KIND+=("$kind"); KEY+=("$key")
  if [ "$kind" = JOB ]; then NODE+=("$a"); IMAGE+=("$b"); NAME+=("$c"); DRIVER+=("$d")
  else NODE+=("-"); IMAGE+=("$a"); NAME+=("$b"); DRIVER+=("-"); fi
done < "$RUN/plan.tsv"

if [ "$LIST" = 1 ]; then
  for i in "${!KIND[@]}"; do
    if [ "${KIND[$i]}" = JOB ]; then printf 'JOB  %-14s %s\n' "${KEY[$i]}-${NODE[$i]}" "${NAME[$i]}"
    else printf 'GAP  %-14s %s (%s, checked by CI)\n' "${KEY[$i]}" "${NAME[$i]}" "${IMAGE[$i]}"; fi
  done
  exit 0
fi

CLI_IMAGE=$(node -p 'require(process.argv[1]).dockerCli' "$REPO/scripts/ci-local.images.json")
# The job image: the pinned node image plus the pinned docker CLI binary. Built once per pin pair.
job_image() {
  local base=$1 tag
  tag="feat-ci-local:$(printf '%s %s' "$base" "$CLI_IMAGE" | shasum -a 256 | cut -c1-16)"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    printf 'FROM %s\nCOPY --from=%s /usr/local/bin/docker /usr/local/bin/docker\n' "$base" "$CLI_IMAGE" \
      | docker build -q -t "$tag" - >/dev/null
  fi
  echo "$tag"
}

SUMMARY="$RUN/summary.txt"
: > "$SUMMARY"
echo "ci-local: commit $SHA ($(git -C "$REPO" log -1 --format=%s "$SHA" | cut -c1-72))"
echo "ci-local: run directory $RUN"
if [ "$REF" = HEAD ] && [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  echo "ci-local: note: the working tree has uncommitted changes; they are not part of this run"
fi

PASS=0; FAIL=0; GAPS=0; T_ALL=$(date +%s)
for i in "${!KIND[@]}"; do
  if [ "${KIND[$i]}" = GAP ]; then
    line="GAP   ${KEY[$i]}  ${NAME[$i]} (runs-on ${IMAGE[$i]}): not run locally, checked by CI"
    echo "$line" | tee -a "$SUMMARY"; GAPS=$((GAPS + 1)); continue
  fi
  key=${KEY[$i]}; node=${NODE[$i]}
  jd="$RUN/$key-$node"; log="$RUN/$key-$node.log"
  mkdir -p "$jd/src" "$jd/tmp"; JOBDIRS+=("$jd")
  tar -xf "$RUN/source.tar" -C "$jd/src"
  tag=$(job_image "${IMAGE[$i]}")
  name="feat-ci-test-$key-$node-$ID"
  before=$(docker ps -a --format '{{.Names}}')
  echo "ci-local: RUN   $key-$node  ${NAME[$i]}  (log $log)"
  t0=$(date +%s)
  CURRENT=$name
  if docker run --rm --name "$name" --label "feat-ci-local.pid=$$" --network host \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$jd:$jd" -v "$RUN/plan:$RUN/plan:ro" -v "$STORE:$STORE" \
      -w "$jd/src" -e CI=true -e GITHUB_ACTIONS=true -e TMPDIR="$jd/tmp" -e npm_config_store_dir="$STORE" \
      "$tag" bash "${DRIVER[$i]}" > "$log" 2>&1 < /dev/null; then rc=0; else rc=$?; fi
  CURRENT=""
  secs=$(( $(date +%s) - t0 ))
  # Containers a test started and left behind: CI's runner is discarded, so remove them here and say so.
  leaked=$(docker ps -a --format '{{.Names}}' | grep -E '^feat-.*-test-' | grep -vxF -f <(printf '%s\n' "$before") || true)
  if [ -n "$leaked" ]; then
    echo "ci-local: WARN  $key-$node left containers behind, removing: $(echo $leaked)" | tee -a "$SUMMARY"
    echo "$leaked" | xargs docker rm -f -v >/dev/null 2>&1 || true
  fi
  if [ "$rc" = 0 ]; then verdict=PASS; PASS=$((PASS + 1)); else verdict=FAIL; FAIL=$((FAIL + 1)); fi
  failed_step=""
  [ "$rc" = 0 ] || failed_step=$(grep -E '^::ci-local:: step [0-9]+ rc=[1-9]' "$log" | head -1 | sed 's/^::ci-local:: //' || true)
  line=$(printf '%-4s  %-8s  %-28s %5ss  %s' "$verdict" "$key-$node" "${NAME[$i]}" "$secs" "$log")
  [ -z "$failed_step" ] || line="$line  [$failed_step]"
  echo "$line" | tee -a "$SUMMARY"
  if [ "$KEEP" = 0 ]; then rm -rf "$jd/src" "$jd/tmp" || echo "ci-local: could not remove $jd" >&2; fi
done

echo "ci-local: $PASS passed, $FAIL failed, $GAPS gap(s) in $(( $(date +%s) - T_ALL ))s for $SHA" | tee -a "$SUMMARY"
echo "ci-local: summary $SUMMARY"
[ "$FAIL" = 0 ]
