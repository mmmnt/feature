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
#   --skip-passed  exit 0 without running when this commit already passed the default selection (below)
#   --record-path  print where this commit's pass record lives and exit
#   --changed      the inner loop: check only the packages changed since origin/main and their dependents, at every
#                  tier the gate runs for them (scripts/ci-local-scope.mjs); a shared root widens to the full gate, a
#                  change that maps to nothing is refused. Leaves no pass record: a push needs the full gate.
#   --since <ref>  as --changed, against <ref> instead of origin/main
#   --rebased      after rebasing a commit that passed the full gate: check what differs between that commit
#                  (ORIG_HEAD) and this one; a pass records this commit as passed (rebased from ORIG_HEAD)
# env: CI_LOCAL_DIR  where runs go (default ${TMPDIR:-/tmp}/feat-ci-local); Docker Desktop must share it
#
# A run of the default selection (no --job, --node or --all) that passes every job leaves a pass record in the
# clone's git directory, feat-ci-local/passed/<commit>-<runner>, where <runner> hashes this script, the plan
# script and the image pins as they are on disk: a runner change makes every record stale. A run is a function
# of the commit and the runner (it checks a `git archive` of the commit, never the working tree), so with
# --skip-passed (.githooks/pre-push passes it) a commit that passed is not run again, as when its tag is pushed
# after the branch.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REF=HEAD
KEEP=0
LIST=0
ALL=0
NODES=0
JOBS=0
SKIP_PASSED=0
RECORD_PATH=0
SCOPE_BASE=""
REBASED=0
FILTERS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=${2:?--ref needs a commit}; shift 2 ;;
    --job) FILTERS+=(--job "${2:?--job needs a name}"); JOBS=1; shift 2 ;;
    --node) FILTERS+=(--node "${2:?--node needs a major}"); NODES=1; shift 2 ;;
    --all) ALL=1; shift ;;
    --keep) KEEP=1; shift ;;
    --list) LIST=1; shift ;;
    --skip-passed) SKIP_PASSED=1; shift ;;
    --record-path) RECORD_PATH=1; shift ;;
    --changed) SCOPE_BASE=origin/main; shift ;;
    --since) SCOPE_BASE=${2:?--since needs a ref}; shift 2 ;;
    --rebased) SCOPE_BASE=ORIG_HEAD; REBASED=1; shift ;;
    -h|--help) sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ci-local: unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$ALL" = 1 ] && [ "$NODES" = 1 ]; then echo "ci-local: --all and --node exclude each other" >&2; exit 2; fi
DEFAULT_SELECTION=0
if [ "$JOBS" = 0 ] && [ "$NODES" = 0 ] && [ "$ALL" = 0 ]; then DEFAULT_SELECTION=1; fi
if [ "$SKIP_PASSED" = 1 ] && [ "$DEFAULT_SELECTION" = 0 ]; then
  echo "ci-local: --skip-passed applies to the default selection only, not with --job, --node or --all" >&2; exit 2
fi

for tool in git node docker tar shasum; do
  command -v "$tool" >/dev/null || { echo "ci-local: $tool is not on PATH" >&2; exit 2; }
done

SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
RUNNER=$(cat "$REPO/scripts/ci-local.sh" "$REPO/scripts/ci-local-plan.mjs" "$REPO/scripts/ci-local.images.json" "$REPO/scripts/docker-sweep.sh" "$REPO/scripts/gate-lock.sh" "$REPO/scripts/ci-local-watchdog.sh" | shasum -a 256 | cut -c1-16)
GIT_COMMON=$(cd "$REPO" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
RECORD="$GIT_COMMON/feat-ci-local/passed/$SHA-$RUNNER"
if [ "$RECORD_PATH" = 1 ]; then echo "$RECORD"; exit 0; fi

# The inner loop (--changed, --since, --rebased): what the change covers decides what runs.
SCOPED=0; SCOPE_JSON=""
if [ -n "$SCOPE_BASE" ]; then
  if [ "$DEFAULT_SELECTION" = 0 ] || [ "$SKIP_PASSED" = 1 ]; then
    echo "ci-local: --changed, --since and --rebased choose what runs themselves; not with --job, --node, --all or --skip-passed" >&2; exit 2
  fi
  BASE_SHA=$(git -C "$REPO" rev-parse --verify "$SCOPE_BASE^{commit}" 2>/dev/null) || { echo "ci-local: $SCOPE_BASE names no commit" >&2; exit 2; }
  if [ "$REBASED" = 1 ]; then
    ORIG_RECORD="$GIT_COMMON/feat-ci-local/passed/$BASE_SHA-$RUNNER"
    if [ ! -f "$ORIG_RECORD" ]; then
      echo "ci-local: --rebased: ORIG_HEAD ($BASE_SHA) has no full-gate pass record for this runner; run scripts/ci-local.sh on it, or the full gate on this commit" >&2
      exit 2
    fi
  else
    BASE_SHA=$(git -C "$REPO" merge-base "$BASE_SHA" "$SHA")
  fi
  SCOPE_JSON=$(node "$REPO/scripts/ci-local-scope.mjs" --repo "$REPO" --base "$BASE_SHA" --head "$SHA") || exit 2
  mode=$(node -p 'JSON.parse(process.argv[1]).mode' "$SCOPE_JSON")
  why=$(node -p 'JSON.parse(process.argv[1]).why ?? ""' "$SCOPE_JSON")
  case "$mode" in
    none) echo "ci-local: nothing to check between $BASE_SHA and $SHA ($why): refused, a check that runs nothing proves nothing; run the full gate (scripts/ci-local.sh)" >&2; exit 2 ;;
    full) echo "ci-local: $why: the full gate runs" ;;
    scoped) SCOPED=1; echo "ci-local: scoped check of $(node -p 'JSON.parse(process.argv[1]).packages.join(", ")' "$SCOPE_JSON") (changed since $BASE_SHA)" ;;
  esac
fi
if [ "$SKIP_PASSED" = 1 ] && [ -f "$RECORD" ]; then
  echo "ci-local: $SHA already passed ($(head -1 "$RECORD")), not run again; record $RECORD"
  exit 0
fi

docker info >/dev/null 2>&1 || { echo "ci-local: the Docker daemon is not reachable" >&2; exit 2; }

# The host rule every gate on this machine keeps (scripts/gate-lock.sh, flmnt decision b4e3656a): one gate at a time
# through the host-wide lock ~/.flmnt/gate.lock (shared with flmnt's gate), then start while the daemon's containers
# use under 12 cores; at most 30 minutes per run (the watchdog below). The lock is held until this run exits, however
# it exits; a run that waits says for what.
CLI_IMAGE=$(node -p 'require(process.argv[1]).dockerCli' "$REPO/scripts/ci-local.images.json")
bash "$REPO/scripts/gate-lock.sh" acquire $$ || exit 2
trap 'bash "$REPO/scripts/gate-lock.sh" release $$' EXIT

# A run killed outright (SIGKILL) cannot clean up. Its job container and every container its tests started carry
# the runner's pid (feat-test.owner-pid; the tests read it from FEAT_CI_LOCAL_PID), so a later run removes what a
# run that is gone left, with the containers' anonymous volumes. Label-scoped: nothing else on the daemon is touched.
bash "$REPO/scripts/docker-sweep.sh" --gone | sed 's/^/ci-local: /'

BASE=${CI_LOCAL_DIR:-${TMPDIR:-/tmp}/feat-ci-local}
mkdir -p "$BASE"
BASE=$(cd "$BASE" && pwd -P)
ID=$(date +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
RUN="$BASE/run-$ID"
mkdir -p "$RUN/tree" "$RUN/logs"
: > "$RUN/current"
bash "$REPO/scripts/ci-local-watchdog.sh" "${CI_LOCAL_MAX_SECONDS:-1800}" $$ "$RUN/current" &
WATCHDOG=$!

CURRENT=""
TREES=()
cleanup() {
  local rc=$?
  kill "$WATCHDOG" 2>/dev/null || true
  if [ -n "$CURRENT" ]; then docker rm -f -v "$CURRENT" >/dev/null 2>&1 || true; fi
  bash "$REPO/scripts/docker-sweep.sh" --run $$ | sed 's/^/ci-local: /'
  if [ "$KEEP" = 0 ] && [ "${#TREES[@]}" -gt 0 ]; then
    for d in "${TREES[@]}"; do rm -rf "$d" 2>/dev/null || echo "ci-local: could not remove $d" >&2; done
  fi
  rm -f "$RUN/source.tar"
  if [ "$LIST" = 1 ]; then rm -rf "$RUN"; fi
  bash "$REPO/scripts/gate-lock.sh" release $$
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$REPO" archive --format=tar -o "$RUN/source.tar" "$SHA"
tar -xf "$RUN/source.tar" -C "$RUN/tree" .github/workflows/ci.yml package.json .tool-versions pnpm-lock.yaml

if [ "$ALL" = 0 ] && [ "$NODES" = 0 ]; then
  DEFAULT_NODE=$(awk '$1 == "nodejs" { split($2, v, "."); print v[1] }' "$RUN/tree/.tool-versions")
  [ -n "$DEFAULT_NODE" ] || { echo "ci-local: .tool-versions names no nodejs version" >&2; exit 2; }
  FILTERS+=(--node "$DEFAULT_NODE")
fi

node "$REPO/scripts/ci-local-plan.mjs" \
  --workflow "$RUN/tree/.github/workflows/ci.yml" --package "$RUN/tree/package.json" \
  --images "$REPO/scripts/ci-local.images.json" --out "$RUN/plan" ${FILTERS[@]+"${FILTERS[@]}"} > "$RUN/plan.tsv"

# A scoped check replaces each group's driver with one job that runs the gate's tiers for the scope only: the
# install and the build (every package, from turbo's cache, since feat loads every configured adapter), their typecheck and workspace tests, the global spec checks (verify,
# audit, lint, a few seconds), and the generated suites of the scope's specs (every spec when a toolchain package
# is in scope), through a feat.config overlay whose exclude list leaves out every other package.
if [ "$SCOPED" = 1 ]; then
  PM=$(node -p 'require(process.argv[1]).packageManager.replace(/^pnpm@/, "")' "$RUN/tree/package.json")
  node -e '
    const s = JSON.parse(process.argv[1]);
    const f = (flag, names) => names.map((n) => `${flag}=${n}`).join(" ");
    process.stdout.write([
      `PKG_FILTERS="${f("--filter", s.packages)}"`,
      `ALL_SPECS=${s.allSpecs ? 1 : 0}`,
      `CORPUS=${s.corpus ? 1 : 0}`,
      `SCOPE_DIRS="${s.dirs.join(" ")}"`,
    ].join("\n") + "\n");' "$SCOPE_JSON" > "$RUN/plan/scope.env"
  awk -F '\t' -v drv="$RUN/plan/scoped.sh" 'BEGIN { OFS = "\t" } $1 == "GROUP" { $4 = drv; $5 = "scoped"; print; node = $2 } END { print "JOB", "scoped", node, "Scoped check" }' "$RUN/plan.tsv" > "$RUN/plan.scoped.tsv"
  mv "$RUN/plan.scoped.tsv" "$RUN/plan.tsv"
  cat > "$RUN/plan/scoped.sh" <<SCOPED
#!/usr/bin/env bash
# Generated by scripts/ci-local.sh --changed/--since/--rebased: the gate's tiers for the scope only.
set -uo pipefail
LOGS=\$1
. "$RUN/plan/scope.env"
NODE=\$(node -p 'process.versions.node.split(".")[0]')
log="\$LOGS/scoped-\$NODE.log"; failed=0; t0=\$(date +%s)
say() { printf '::ci-local:: %s\n' "\$*" | tee -a "\$log"; }
step() { local name=\$1 t rc; shift; say "scoped RUN \$name"; t=\$(date +%s); ( "\$@" ) >> "\$log" 2>&1 < /dev/null; rc=\$?
  say "scoped rc=\$rc \$(( \$(date +%s) - t ))s \$name"; [ "\$rc" = 0 ] || failed=1; }
say "scoped check: \$PKG_FILTERS (all specs: \$ALL_SPECS)"
step "pnpm $PM" npm i -g --no-audit --no-fund pnpm@$PM
step "Install" pnpm install --frozen-lockfile
step "Build (every package: feat loads the configured adapters; turbo's cache rebuilds only what changed)" pnpm build
step "Typecheck" npx turbo run typecheck \$PKG_FILTERS
[ "\$CORPUS" = 1 ] && step "Corpus validation" pnpm corpus:validate
step "Workspace tests" npx turbo run test \$PKG_FILTERS --concurrency="\${FEAT_TEST_CONCURRENCY:-2}"
step "feat verify" node packages/feature/bin/run.js verify
step "feat audit" node packages/feature/bin/run.js audit
step "feat lint" node packages/feature/bin/run.js lint
if [ "\$ALL_SPECS" = 1 ]; then cfg=feat.config.json
else
  cfg=feat.scoped.config.json
  node -e '
    const fs = require("fs"); const base = JSON.parse(fs.readFileSync("feat.config.json", "utf8"));
    const keep = new Set(process.argv[1].split(" ").filter(Boolean));
    const others = ["packages", "adapters"].flatMap((g) => fs.readdirSync(g).map((d) => g + "/" + d)).filter((d) => !keep.has(d));
    const specs = { ...base.specs, exclude: [...(base.specs.exclude ?? []), ...others.map((d) => d + "/**")] };
    fs.writeFileSync(process.argv[2], JSON.stringify({ extends: "./feat.config.json", environment: base.environment, specs }, null, 2));' "\$SCOPE_DIRS" "\$cfg"
fi
step "feat run (the scope's generated suites)" node packages/feature/bin/run.js run -c "\$cfg"
say "result scoped rc=\$failed \$(( \$(date +%s) - t0 ))s"
printf '::ci-local:: =result scoped %s %s\n' "\$failed" "\$(( \$(date +%s) - t0 ))"
printf '::ci-local:: =shared 0 0\n'
exit 0
SCOPED
  chmod +x "$RUN/plan/scoped.sh"
fi

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

# The runner's parallelism: vitest gives a pool availableParallelism - 1 workers, 3 on a 4-vCPU ubuntu-latest runner
# and 15 in a 16-CPU Docker Desktop VM, where 15 workers beside the product containers their specs start were
# descheduled for up to 54 s at a time and a worker's RPC timed out past 60 s ("Timeout calling onTaskUpdate",
# every test passed; measured 2026-11-14). Override with CI_LOCAL_MAX_WORKERS.
MAX_WORKERS=${CI_LOCAL_MAX_WORKERS:-3}

# Workspace tests run their packages' vitest processes through turbo, 10 at a time by default, each with up to
# MAX_WORKERS workers: 30 workers beside the product containers in one VM, and "Timeout calling onTaskUpdate" came
# back on 2026-11-16 despite the worker cap (flmnt exploration 7858a34f). ci-local runs 2 packages at once
# (founder ruling 2026-11-17); CI's step reads the same variable and keeps turbo's default when it is unset.
FEAT_TEST_CONCURRENCY=${CI_LOCAL_TURBO_CONCURRENCY:-2}

# Turbo's build cache (founder ruling 2026-11-17): a docker volume per lockfile, toolchain and image, so a commit
# whose packages are unchanged rebuilds nothing. Only `build` is cached (turbo.json marks test and typecheck
# `cache: false`: a replayed test result proves nothing about this commit). Bounded like flmnt's gate caches
# (b24b9525): at most CI_LOCAL_TURBO_CACHES_MAX volumes (default 4), the least recently used removed past it, and a
# run refuses to start while the Docker VM has under CI_LOCAL_DISK_MIN_GB free (default 20), rather than fail
# mid-run. The volumes are keyed by lockfile, not by checkout, so a removed worktree leaves nothing of its own.
TURBO_USED="$GIT_COMMON/feat-ci-local/turbo-used"
mkdir -p "$TURBO_USED"
turbo_volume() { # <node image>
  printf 'feat-ci-cache-turbo-%s' "$(cat "$RUN/tree/pnpm-lock.yaml" "$RUN/tree/.tool-versions" <(printf '%s' "$1") | shasum -a 256 | cut -c1-12)"
}
free_gb=$(docker run --rm --network none --label "feat-test.owner-pid=$$" "$CLI_IMAGE" df -Pk / 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
if [ -z "$free_gb" ] || [ "$free_gb" -lt "${CI_LOCAL_DISK_MIN_GB:-20}" ]; then
  echo "ci-local: the Docker VM has ${free_gb:-an unreadable number of} GB free, under the floor of ${CI_LOCAL_DISK_MIN_GB:-20} GB: free space (docker system df; old feat-ci-cache-* volumes) or set CI_LOCAL_DISK_MIN_GB" >&2
  exit 2
fi
sweep_turbo() { # keep the CI_LOCAL_TURBO_CACHES_MAX most recently used, never one a container has mounted
  local keep=${CI_LOCAL_TURBO_CACHES_MAX:-4} v n=0
  for v in $(docker volume ls -q --filter name=feat-ci-cache-turbo- | while read -r v; do
      printf '%s %s\n' "$(stat -f %m "$TURBO_USED/$v" 2>/dev/null || stat -c %Y "$TURBO_USED/$v" 2>/dev/null || echo 0)" "$v"; done | sort -rn | awk '{print $2}'); do
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    if [ -n "$(docker ps -aq --filter volume="$v")" ]; then continue; fi
    docker volume rm "$v" >/dev/null 2>&1 && { rm -f "$TURBO_USED/$v"; echo "ci-local: removed the least recently used turbo cache $v (cap $keep)"; }
  done
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
  tvol=$(turbo_volume "${GROUPS_IMAGE[$gi]}"); touch "$TURBO_USED/$tvol"; mounts+=(-v "$tvol:/ci-cache/turbo")
  while IFS=$'\t' read -r kind a b; do
    if [ "$kind" = CACHE ] && [ "$a" = "$node" ]; then mounts+=(-v "$(cache_mount "$b")"); fi
  done < "$RUN/plan.tsv"
  name="feat-ci-test-node$node-$ID"
  out="$RUN/logs/container-$node.log"
  before=$(docker ps -a --format '{{.Names}}')
  echo "ci-local: RUN   Node $node in $name (logs $RUN/logs)"
  t0=$(date +%s)
  CURRENT=$name
  echo "$name" > "$RUN/current"
  if docker run --rm --name "$name" --label "feat-test.owner-pid=$$" -e FEAT_CI_LOCAL_PID=$$ -e FEAT_CI_LOCAL_CONTAINER="$name" -e VITEST_MAX_FORKS="$MAX_WORKERS" -e VITEST_MAX_THREADS="$MAX_WORKERS" -e FEAT_TEST_CONCURRENCY="$FEAT_TEST_CONCURRENCY" -e TURBO_CACHE_DIR=/ci-cache/turbo --network host \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$tree:$tree" -v "$RUN/plan:$RUN/plan:ro" -v "$RUN/logs:$RUN/logs" "${mounts[@]}" \
      -w "$tree/src" -e CI=true -e GITHUB_ACTIONS=true -e TMPDIR="$tree/tmp" -e npm_config_store_dir=/ci-cache/pnpm-store \
      "$tag" bash "${GROUPS_DRIVER[$gi]}" "$RUN/logs" > "$out" 2>&1 < /dev/null; then crc=0; else crc=$?; fi
  CURRENT=""
  : > "$RUN/current"
  secs=$(( $(date +%s) - t0 ))
  # What this run's tests started and left behind (CI's runner is discarded): removed by this run's label, with the
  # containers' anonymous volumes, and said. Removal is label-scoped: another ci-local run, in another clone or
  # session, shares the daemon and starts containers of the same names.
  bash "$REPO/scripts/docker-sweep.sh" --run $$ | sed "s/^docker-sweep: /ci-local: WARN  Node $node: /" | tee -a "$SUMMARY"
  # A test container with no owner label would escape every sweep: named here, not removed (it may be another run's).
  unlabelled=$(docker ps -a --format '{{.Names}}	{{.Label "feat-test.owner-pid"}}' | awk -F '\t' '$2 == "" { print $1 }' \
    | grep -E '^feat-.*-test-' | grep -vxF -f <(printf '%s\n' "$before") || true)
  if [ -n "$unlabelled" ]; then
    echo "ci-local: WARN  Node $node started containers with no feat-test.owner-pid label: $(echo $unlabelled)" | tee -a "$SUMMARY"
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
sweep_turbo

echo "ci-local: $PASS passed, $FAIL failed in $(( $(date +%s) - T_ALL ))s for $SHA" | tee -a "$SUMMARY"
echo "ci-local: summary $SUMMARY"
if [ "$FAIL" = 0 ] && [ "$PASS" -gt 0 ] && [ "$DEFAULT_SELECTION" = 1 ] && { [ "$SCOPED" = 0 ] || [ "$REBASED" = 1 ]; }; then
  # Written through a temporary name, so a record is never half there. A scoped check records a pass only after
  # --rebased: what differs from a commit that passed the full gate has passed every tier for its scope.
  mkdir -p "$(dirname "$RECORD")"
  how="$PASS passed"; [ "$REBASED" = 1 ] && how="$how, rebased from $BASE_SHA$([ "$SCOPED" = 1 ] && echo " (scoped check)")"
  { echo "$how at $(date -u +%Y-%m-%dT%H:%M:%SZ)"; cat "$SUMMARY"; } > "$RECORD.tmp.$$"
  mv "$RECORD.tmp.$$" "$RECORD"
  echo "ci-local: pass recorded in $RECORD"
fi
[ "$FAIL" = 0 ]
