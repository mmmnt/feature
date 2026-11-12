#!/usr/bin/env bash
# Run the ubuntu jobs of .github/workflows/ci.yml locally, in throwaway Linux containers.
#
# The jobs are not listed here: scripts/ci-local-plan.mjs reads ci.yml from the commit being checked, expands
# each job's matrix, evaluates the steps' `if:` and writes the `run:` steps as one driver per Node version. That
# driver runs the steps the jobs share (checkout, setup, Install, Build) once, then each job's own steps, and
# reports each job. A job CI runs on another OS is printed as a GAP line, left to CI.
#
# By default only the Node version of .tool-versions runs (founder ruling: "only run tests for 24 locally, CI can
# catch the rest"); the other matrix entries are printed as OFF lines. --node or --all opts in to them.
#
# The commit's `git archive` is extracted under $CI_LOCAL_DIR and mounted at the same absolute path in the
# container, so a path a test hands the Docker daemon (a bind mount of its tree, or of $TMPDIR, which points
# inside that directory) resolves to the same files. The container has the docker CLI and the host's socket,
# and runs on the host network, so the product containers a test starts are reached on 127.0.0.1 at their
# published ports, as on a GitHub runner. Caches live in docker volumes named feat-ci-cache-*: the pnpm store
# (CI's setup-node `cache: pnpm`), every actions/cache path ci.yml declares, and Playwright's browser and apt
# downloads. `docker volume rm` them to start cold.
#
# usage: scripts/ci-local.sh [--ref <commit>] [--job <id|name>]... [--node <major>]... [--all] [--keep] [--list]
#   --ref   the commit to check (default HEAD); uncommitted changes are never part of the run
#   --job   a job id from ci.yml (check, test, spec) or the start of its name; repeatable
#   --node  a matrix Node major (20, 22, 24, 26) instead of the default; repeatable
#   --all   every Node version of the matrix
#   --keep  keep the trees after the run (default: removed, the logs stay)
#   --list  print what the filters select and exit
# env: CI_LOCAL_DIR  where runs go (default ${TMPDIR:-/tmp}/feat-ci-local); Docker Desktop must share it
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REF=HEAD
KEEP=0
LIST=0
ALL=0
NODES=0
FILTERS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=${2:?--ref needs a commit}; shift 2 ;;
    --job) FILTERS+=(--job "${2:?--job needs a name}"); shift 2 ;;
    --node) FILTERS+=(--node "${2:?--node needs a major}"); NODES=1; shift 2 ;;
    --all) ALL=1; shift ;;
    --keep) KEEP=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ci-local: unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$ALL" = 1 ] && [ "$NODES" = 1 ]; then echo "ci-local: --all and --node exclude each other" >&2; exit 2; fi

for tool in git node docker tar; do
  command -v "$tool" >/dev/null || { echo "ci-local: $tool is not on PATH" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "ci-local: the Docker daemon is not reachable" >&2; exit 2; }

# A run killed outright (SIGKILL) cannot remove its container. Each one carries the runner's pid, so a later run
# removes those whose runner is gone.
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
mkdir -p "$RUN/tree" "$RUN/logs"

CURRENT=""
TREES=()
cleanup() {
  local rc=$?
  if [ -n "$CURRENT" ]; then docker rm -f "$CURRENT" >/dev/null 2>&1 || true; fi
  if [ "$KEEP" = 0 ] && [ "${#TREES[@]}" -gt 0 ]; then
    for d in "${TREES[@]}"; do rm -rf "$d" 2>/dev/null || echo "ci-local: could not remove $d" >&2; done
  fi
  rm -f "$RUN/source.tar"
  if [ "$LIST" = 1 ]; then rm -rf "$RUN"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$REPO" archive --format=tar -o "$RUN/source.tar" "$SHA"
tar -xf "$RUN/source.tar" -C "$RUN/tree" .github/workflows/ci.yml package.json .tool-versions

if [ "$ALL" = 0 ] && [ "$NODES" = 0 ]; then
  DEFAULT_NODE=$(awk '$1 == "nodejs" { split($2, v, "."); print v[1] }' "$RUN/tree/.tool-versions")
  [ -n "$DEFAULT_NODE" ] || { echo "ci-local: .tool-versions names no nodejs version" >&2; exit 2; }
  FILTERS+=(--node "$DEFAULT_NODE")
fi

node "$REPO/scripts/ci-local-plan.mjs" \
  --workflow "$RUN/tree/.github/workflows/ci.yml" --package "$RUN/tree/package.json" \
  --images "$REPO/scripts/ci-local.images.json" --out "$RUN/plan" ${FILTERS[@]+"${FILTERS[@]}"} > "$RUN/plan.tsv"

if [ "$LIST" = 1 ]; then
  while IFS=$'\t' read -r kind a b c d; do
    case "$kind" in
      GROUP) printf 'CONTAINER  Node %s: %s\n' "$a" "$d" ;;
      JOB) printf '  JOB  %-10s %s\n' "$a-$b" "$c" ;;
      CACHE) printf '  CACHE      %s\n' "$b" ;;
      OFF) printf 'OFF  %-10s %s: left to CI (opt in: --node %s or --all)\n' "$a-$b" "$c" "$b" ;;
      GAP) printf 'GAP  %-10s %s (%s): checked by CI\n' "$a" "$c" "$b" ;;
    esac
  done < "$RUN/plan.tsv"
  exit 0
fi

CLI_IMAGE=$(node -p 'require(process.argv[1]).dockerCli' "$REPO/scripts/ci-local.images.json")
# The job image: the pinned node image, the pinned docker CLI binary, and apt keeping what it downloads (the
# apt cache volume). Built once per pin pair.
RECIPE='RUN rm -f /etc/apt/apt.conf.d/docker-clean && echo '"'"'Binary::apt::APT::Keep-Downloaded-Packages "true";'"'"' > /etc/apt/apt.conf.d/10keep-downloads'
job_image() {
  local base=$1 tag
  tag="feat-ci-local:$(printf '%s\n%s\n%s' "$base" "$CLI_IMAGE" "$RECIPE" | shasum -a 256 | cut -c1-16)"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    printf 'FROM %s\nCOPY --from=%s /usr/local/bin/docker /usr/local/bin/docker\n%s\n' "$base" "$CLI_IMAGE" "$RECIPE" \
      | docker build -q -t "$tag" - >/dev/null
  fi
  echo "$tag"
}
# A docker volume for a cached path: ~ is the container's /root.
cache_mount() {
  local p=$1 name
  case "$p" in "~/"*) p="/root/${p#\~/}" ;; esac
  name="feat-ci-cache-$(basename "$p" | tr -c 'a-zA-Z0-9_.\n-' '-')"
  printf '%s:%s' "$name" "$p"
}

SUMMARY="$RUN/summary.txt"
: > "$SUMMARY"
echo "ci-local: commit $SHA ($(git -C "$REPO" log -1 --format=%s "$SHA" | cut -c1-72))"
echo "ci-local: run directory $RUN"
if [ "$REF" = HEAD ] && [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  echo "ci-local: note: the working tree has uncommitted changes; they are not part of this run"
fi

PASS=0; FAIL=0; T_ALL=$(date +%s)
GROUPS_NODE=(); GROUPS_IMAGE=(); GROUPS_DRIVER=()
while IFS=$'\t' read -r kind a b c d; do
  case "$kind" in
    GROUP) GROUPS_NODE+=("$a"); GROUPS_IMAGE+=("$b"); GROUPS_DRIVER+=("$c") ;;
    OFF) echo "OFF   $a-$b  $c: left to CI (opt in: --node $b or --all)" | tee -a "$SUMMARY" ;;
    GAP) echo "GAP   $a  $c (runs-on $b): not run locally, checked by CI" | tee -a "$SUMMARY" ;;
  esac
done < "$RUN/plan.tsv"

# One container per Node version, one at a time.
for gi in "${!GROUPS_NODE[@]}"; do
  node=${GROUPS_NODE[$gi]}
  tree="$RUN/node-$node"
  mkdir -p "$tree/src" "$tree/tmp"; TREES+=("$tree")
  tar -xf "$RUN/source.tar" -C "$tree/src"
  tag=$(job_image "${GROUPS_IMAGE[$gi]}")
  mounts=(-v feat-ci-cache-pnpm-store:/ci-cache/pnpm-store -v feat-ci-cache-ms-playwright:/root/.cache/ms-playwright
    -v feat-ci-cache-apt-archives:/var/cache/apt/archives)
  while IFS=$'\t' read -r kind a b; do
    if [ "$kind" = CACHE ] && [ "$a" = "$node" ]; then mounts+=(-v "$(cache_mount "$b")"); fi
  done < "$RUN/plan.tsv"
  name="feat-ci-test-node$node-$ID"
  out="$RUN/logs/container-$node.log"
  before=$(docker ps -a --format '{{.Names}}')
  echo "ci-local: RUN   Node $node in $name (logs $RUN/logs)"
  t0=$(date +%s)
  CURRENT=$name
  if docker run --rm --name "$name" --label "feat-ci-local.pid=$$" --network host \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$tree:$tree" -v "$RUN/plan:$RUN/plan:ro" -v "$RUN/logs:$RUN/logs" "${mounts[@]}" \
      -w "$tree/src" -e CI=true -e GITHUB_ACTIONS=true -e TMPDIR="$tree/tmp" -e npm_config_store_dir=/ci-cache/pnpm-store \
      "$tag" bash "${GROUPS_DRIVER[$gi]}" "$RUN/logs" > "$out" 2>&1 < /dev/null; then crc=0; else crc=$?; fi
  CURRENT=""
  secs=$(( $(date +%s) - t0 ))
  # Containers a test started and left behind: CI's runner is discarded, so remove them here and say so.
  leaked=$(docker ps -a --format '{{.Names}}' | grep -E '^feat-.*-test-' | grep -vxF -f <(printf '%s\n' "$before") || true)
  if [ -n "$leaked" ]; then
    echo "ci-local: WARN  Node $node left containers behind, removing: $(echo $leaked)" | tee -a "$SUMMARY"
    echo "$leaked" | xargs docker rm -f -v >/dev/null 2>&1 || true
  fi
  shared=$(awk '$1 == "::ci-local::" && $2 == "=shared" { print $4 }' "$out")
  while IFS=$'\t' read -r kind key jn jname; do
    [ "$kind" = JOB ] && [ "$jn" = "$node" ] || continue
    result=$(awk -v k="$key" '$1 == "::ci-local::" && $2 == "=result" && $3 == k { print $4 " " $5 }' "$out")
    log="$RUN/logs/$key-$node.log"
    if [ "$crc" = 0 ] && [ "${result%% *}" = 0 ]; then verdict=PASS; PASS=$((PASS + 1)); else verdict=FAIL; FAIL=$((FAIL + 1)); fi
    detail=""
    if [ "$verdict" = FAIL ]; then
      if [ -z "$result" ]; then detail="  [no result: the container exited $crc, see $out]"
      else
        detail=$(grep -hE '^::ci-local:: .*step [0-9]+ rc=[1-9]' "$RUN/logs/shared-$node.log" "$log" 2>/dev/null | head -1 | sed 's/^::ci-local:: //' || true)
        [ -z "$detail" ] || detail="  [$detail]"
      fi
    fi
    printf '%-4s  %-8s  %-28s %5ss  (+ shared %ss)  %s%s\n' "$verdict" "$key-$node" "$jname" "${result#* }" "${shared:-?}" "$log" "$detail" | tee -a "$SUMMARY"
  done < "$RUN/plan.tsv"
  echo "ci-local: Node $node took ${secs}s" | tee -a "$SUMMARY"
  if [ "$KEEP" = 0 ]; then rm -rf "$tree" || echo "ci-local: could not remove $tree" >&2; fi
done

echo "ci-local: $PASS passed, $FAIL failed in $(( $(date +%s) - T_ALL ))s for $SHA" | tee -a "$SUMMARY"
echo "ci-local: summary $SUMMARY"
[ "$FAIL" = 0 ]
