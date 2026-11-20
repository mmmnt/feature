#!/usr/bin/env bash
# Regenerates the archive fixtures of SPEC-ADPFS-002 with real producers, never with the adapter's own code:
# bsdtar (libarchive 3.x) in its ustar and gnutar formats, and Python's tarfile in its pax format (libarchive puts a
# path that fits the ustar prefix in the prefix, never in a pax header), piped through the zstd CLI (1.5).
# The corrupt fixtures are made from good ones by the byte edits named below. Run from anywhere; writes next to itself.
set -euo pipefail
OUT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
cd "$WORK"
STAMP=202611200000.00
export COPYFILE_DISABLE=1 # macOS bsdtar: no AppleDouble ._ members
TAR=(bsdtar --no-xattrs --no-acls --no-fflags --uid 0 --gid 0 --uname root --gname root)
if bsdtar --help 2>&1 | grep -q -- --no-mac-metadata; then TAR+=(--no-mac-metadata); fi
zst() { zstd -q -19 --no-check -c; }
stamp() { find "$@" -exec touch -t "$STAMP" {} +; }

mkdir m && (
  cd m
  printf '{"id":1}' > a.json
  printf '{"n":1}\n{"n":2}\n' > b.jsonl
  printf 'hello\n' > c.txt
  mkdir d && printf '{"deep":true}' > d/e.json
  stamp .
  "${TAR[@]}" --format ustar -cf ../members.tar a.json b.jsonl c.txt d
)
zst < members.tar > "$OUT/members.tar.zst"

mkdir e && (cd e && : > e.jsonl && stamp . && "${TAR[@]}" --format ustar -cf - e.jsonl) | zst > "$OUT/empty-jsonl.tar.zst"

LONG=workspaces/0b8d2f4e-6f1a-4c8e-9a51-2d3c4b5a6f70/5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b-claude-code/keyframe.jsonl
mkdir l && (
  cd l
  mkdir -p "$(dirname "$LONG")" && printf '{"k":1}\n' > "$LONG"
  stamp .
  "${TAR[@]}" --format gnutar -cf ../long-gnu.tar "$LONG"
  "${TAR[@]}" --format ustar -cf ../long-ustar.tar "$LONG"
)
python3 - "$LONG" <<'PY'
import io, sys, tarfile
name = sys.argv[1]
data = b'{"k":1}\n'
with tarfile.open("long-pax.tar", "w", format=tarfile.PAX_FORMAT) as t:
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), 1795161600, 0o644
    t.addfile(info, io.BytesIO(data))
PY
for f in long-gnu long-pax long-ustar; do zst < "$f.tar" > "$OUT/$f.tar.zst"; done

cp members.tar "$OUT/not-zstd.tar.zst"
head -c "$(( $(wc -c < "$OUT/members.tar.zst") / 2 ))" "$OUT/members.tar.zst" > "$OUT/truncated.tar.zst"
printf 'not a tar\n' | zst > "$OUT/not-tar.tar.zst"
# The checksum field of the first header is bytes 148..155; its first digit is changed.
cp members.tar bad.tar
c=$(dd if=bad.tar bs=1 skip=148 count=1 2>/dev/null)
printf '%s' "$([ "$c" = 1 ] && echo 2 || echo 1)" | dd of=bad.tar bs=1 seek=148 count=1 conv=notrunc 2>/dev/null
zst < bad.tar > "$OUT/bad-checksum.tar.zst"

one() { # one <fixture> <member> <printf-format>
  rm -rf o && mkdir o && (cd o && printf "$3" > "$2" && stamp . && "${TAR[@]}" --format ustar -cf - "$2") | zst > "$OUT/$1"
}
one bad-json.tar.zst x.json '{'
one bad-jsonl.tar.zst y.jsonl '{"n":1}\nnope\n'
one bad-utf8.tar.zst z.txt '\377\376'

mkdir s && (cd s && printf '{"id":1}' > a.json && ln -s a.json link && stamp . && find . -type l -exec touch -h -t "$STAMP" {} + && "${TAR[@]}" --format ustar -cf - a.json link) | zst > "$OUT/symlink.tar.zst"
