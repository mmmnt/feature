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
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION=$(node -p 'require("./adapters/kafka/package.json").dependencies["@confluentinc/kafka-javascript"]')
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "node26-kafka-native: the adapter pins no exact client version ($VERSION)" >&2; exit 1; }
# The tarball built below must be the one pnpm-lock.yaml locks, as the install verifies its own copy.
LOCKED=$(awk -v key="  '@confluentinc/kafka-javascript@$VERSION':" '$0 == key { getline; if (match($0, /integrity: [^}]+/)) print substr($0, RSTART + 11, RLENGTH - 11); exit }' pnpm-lock.yaml)
[ -n "$LOCKED" ] || { echo "node26-kafka-native: pnpm-lock.yaml has no integrity for @confluentinc/kafka-javascript@$VERSION" >&2; exit 1; }
WORK=$(mktemp -d /tmp/ckjs.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

pnpm install --frozen-lockfile --ignore-scripts

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

found=0
for dir in node_modules/.pnpm/@confluentinc+kafka-javascript@"$VERSION"*/node_modules/@confluentinc/kafka-javascript; do
  [ -d "$dir" ] || continue
  rm -rf "$dir/build"
  mkdir -p "$dir/build"
  cp -R "$WORK/src/build/Release" "$dir/build/Release"
  found=1
done
[ "$found" = 1 ] || { echo "node26-kafka-native: no installed @confluentinc/kafka-javascript@$VERSION to place the binary in" >&2; exit 1; }

pnpm rebuild
node -e 'require(require.resolve("@confluentinc/kafka-javascript", { paths: ["adapters/kafka"] })); console.log("node26-kafka-native: @confluentinc/kafka-javascript loads")'
