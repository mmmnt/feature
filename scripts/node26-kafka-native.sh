#!/usr/bin/env bash
# Install the workspace on Node 26 (Linux), where @confluentinc/kafka-javascript cannot build itself.
#
# Confluent publishes no prebuilt binary for Node 26 (ABI node-v147), so the package's install script
# falls back to building librdkafka from source. That build fails inside node_modules: librdkafka bundles
# its static library with an `ar -M` script, and `ar` cuts every path at the '@' of
# node_modules/@confluentinc/... ("file format not recognized"). The same build from a path with no '@'
# succeeds. So: install with scripts off, build the client (the tarball pnpm-lock.yaml locks) in a
# temporary directory with no '@', put the binary where the package looks for it, then run every build
# script. The client's own install script finds its binary and builds nothing.
#
# The built build/Release is kept in $FEAT_KAFKA_NATIVE_CACHE (default ~/.cache/feat-kafka-native) under a
# key of the OS, the Node major and ABI, and the client tarball's lockfile integrity; CI restores that
# directory with actions/cache. With the key's binary there, the build is skipped.
#
# usage: scripts/node26-kafka-native.sh               install the workspace
#        scripts/node26-kafka-native.sh --cache-key   print the cache key and exit
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION=$(node -p 'require("./adapters/kafka/package.json").dependencies["@confluentinc/kafka-javascript"]')
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "node26-kafka-native: the adapter pins no exact client version ($VERSION)" >&2; exit 1; }
# The tarball built below must be the one pnpm-lock.yaml locks, as the install verifies its own copy.
LOCKED=$(awk -v key="  '@confluentinc/kafka-javascript@$VERSION':" '$0 == key { getline; if (match($0, /integrity: [^}]+/)) print substr($0, RSTART + 11, RLENGTH - 11); exit }' pnpm-lock.yaml)
[ -n "$LOCKED" ] || { echo "node26-kafka-native: pnpm-lock.yaml has no integrity for @confluentinc/kafka-javascript@$VERSION" >&2; exit 1; }

# The integrity in base64url, so the key is one path segment.
KEY="kafka-native-$(uname -s)-node$(node -p 'process.versions.node.split(".")[0] + "-abi" + process.versions.modules')-$VERSION-$(printf '%s' "${LOCKED#sha512-}" | tr '+/' '-_' | tr -d '=')"
if [ "${1:-}" = "--cache-key" ]; then echo "$KEY"; exit 0; fi
[ $# -eq 0 ] || { echo "node26-kafka-native: unknown argument $1" >&2; exit 2; }
CACHE="${FEAT_KAFKA_NATIVE_CACHE:-$HOME/.cache/feat-kafka-native}/$KEY"
BINARY=confluent-kafka-javascript.node

WORK=$(mktemp -d /tmp/ckjs.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

pnpm install --frozen-lockfile --ignore-scripts

if [ -f "$CACHE/Release/$BINARY" ]; then
  echo "node26-kafka-native: cache hit $CACHE"
  RELEASE="$CACHE/Release"
else
  echo "node26-kafka-native: cache miss $CACHE, building"
  (
    cd "$WORK"
    npm pack "@confluentinc/kafka-javascript@$VERSION" >/dev/null
    got="sha512-$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "confluentinc-kafka-javascript-$VERSION.tgz")"
    [ "$got" = "$LOCKED" ] || { echo "node26-kafka-native: the packed tarball's integrity $got is not the lockfile's $LOCKED" >&2; exit 1; }
    mkdir src
    tar -xzf "confluentinc-kafka-javascript-$VERSION.tgz" -C src --strip-components=1
    cd src
    npm install --no-audit --no-fund --ignore-scripts >/dev/null
    ./node_modules/.bin/node-pre-gyp rebuild
  )
  RELEASE="$WORK/src/build/Release"
  # Filled through a temporary name, so a cache directory never holds half a binary.
  mkdir -p "$(dirname "$CACHE")"
  rm -rf "$CACHE.tmp.$$"
  mkdir -p "$CACHE.tmp.$$"
  cp -R "$RELEASE" "$CACHE.tmp.$$/Release"
  rm -rf "$CACHE"
  mv "$CACHE.tmp.$$" "$CACHE"
fi

found=0
for dir in node_modules/.pnpm/@confluentinc+kafka-javascript@"$VERSION"*/node_modules/@confluentinc/kafka-javascript; do
  [ -d "$dir" ] || continue
  rm -rf "$dir/build"
  mkdir -p "$dir/build"
  cp -R "$RELEASE" "$dir/build/Release"
  found=1
done
[ "$found" = 1 ] || { echo "node26-kafka-native: no installed @confluentinc/kafka-javascript@$VERSION to place the binary in" >&2; exit 1; }

pnpm rebuild
node -e 'require(require.resolve("@confluentinc/kafka-javascript", { paths: ["adapters/kafka"] })); console.log("node26-kafka-native: @confluentinc/kafka-javascript loads")'
