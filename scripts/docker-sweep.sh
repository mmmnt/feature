#!/usr/bin/env bash
# Remove what test runs left in Docker, by label only: every container, network and volume a run of this
# repository starts carries feat-test.owner-pid=<pid of the run that owns it> (ci-local's own pid, which it hands
# its jobs as FEAT_CI_LOCAL_PID, else the test process's). Nothing unlabelled is touched, and nothing is pruned
# globally: other repositories and sessions share the daemon.
#
# A container is removed with -v: an image that declares VOLUME (KurrentDB, Neo4j, Kafka) gets an anonymous
# volume per container, which `docker rm` alone leaves behind, and which outlives any label filter.
#
# usage: scripts/docker-sweep.sh --gone        what a run whose pid is no longer alive left (a run killed outright)
#        scripts/docker-sweep.sh --run <pid>   what the run <pid> left (ci-local, after each Node version)
set -uo pipefail

LABEL=feat-test.owner-pid
case "${1:-}" in
  --gone) MODE=gone ;;
  --run) MODE=run; WANT=${2:?--run needs a pid} ;;
  *) echo "usage: scripts/docker-sweep.sh --gone | --run <pid>" >&2; exit 2 ;;
esac

# stdin: "<name>\t<owner pid>" per object; prints the names this mode removes.
pick() {
  local name owner
  while IFS=$'\t' read -r name owner; do
    [ -n "$name" ] && [ -n "$owner" ] || continue
    if [ "$MODE" = run ]; then
      [ "$owner" = "$WANT" ] && echo "$name"
    elif ! kill -0 "$owner" 2>/dev/null; then
      echo "$name"
    fi
  done
  return 0
}

FORMAT="{{.Name}}	{{.Label \"$LABEL\"}}"
# containers first: a network or volume in use by one cannot be removed
containers=$(docker ps -a --filter "label=$LABEL" --format "{{.Names}}	{{.Label \"$LABEL\"}}" 2>/dev/null | pick)
networks=$(docker network ls --filter "label=$LABEL" --format "$FORMAT" 2>/dev/null | pick)
volumes=$(docker volume ls --filter "label=$LABEL" --format "$FORMAT" 2>/dev/null | pick)

remove() {
  local what=$1 list=$2
  shift 2
  [ -n "$list" ] || return 0
  # shellcheck disable=SC2086
  echo "$list" | xargs "$@" >/dev/null 2>&1 || true
  echo "docker-sweep: removed $what: $(echo $list)"
}
remove containers "$containers" docker rm -f -v
remove networks "$networks" docker network rm
remove volumes "$volumes" docker volume rm -f
exit 0
