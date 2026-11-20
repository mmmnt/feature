// SPEC-ADPFS-002: the members of a tar+zstd archive, read in full or not at all. The tar stream is parsed here, with
// no dependency: 512-byte headers, the ustar `prefix` + `name`, a GNU long-name `L` entry and a pax `x` `path` record
// naming the next entry, `g` global headers ignored. zstd is node:zlib's (Node >= 22.15, the package's engines).

import { zstdDecompressSync } from "node:zlib";

export type Member = { name: string; json: unknown } | { name: string; lines: unknown[] } | { name: string; text: string };

export type ArchiveReading =
  | { ok: true; members: Member[] }
  | { ok: false; reason: "zstd" | "tar" | "json" | "utf8"; member?: string };

const BLOCK = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A NUL-terminated header field as text. */
function field(h: Buffer, at: number, len: number): string {
  const raw = h.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString("utf8");
}

/** An octal header number (size, checksum), or undefined when the field holds none. */
function octal(h: Buffer, at: number, len: number): number | undefined {
  const s = field(h, at, len).trim();
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : undefined;
}

/** The header checksum: the sum of every byte with the checksum field counted as spaces. */
function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8);
  if (stored === undefined) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === stored;
}

/** The `path` record of a pax extended header (records are "<len> <key>=<value>\n"). */
function paxPath(body: Buffer): string | undefined {
  let path: string | undefined;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number(body.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = body.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += len;
  }
  return path;
}

function decode(name: string, data: Buffer): ArchiveReading | Member {
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    return { ok: false, reason: "utf8", member: name };
  }
  try {
    if (name.endsWith(".json")) return { name, json: JSON.parse(text) };
    if (name.endsWith(".jsonl")) {
      const rows = text.split("\n");
      if (rows.at(-1) === "") rows.pop();
      return { name, lines: rows.map((r) => JSON.parse(r.endsWith("\r") ? r.slice(0, -1) : r)) };
    }
  } catch {
    return { ok: false, reason: "json", member: name };
  }
  return { name, text };
}

/**
 * True when `bytes` is one or more whole zstd frames (RFC 8878 §3.1) and nothing else. node:zlib answers a truncated
 * frame with whatever it could decode and no error (measured on Node 24.1: half a frame decompresses to 0 bytes), so a
 * cut archive would read as an empty one; the frame and block headers are walked first, without decompressing.
 */
function wholeZstdFrames(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return false;
    const magic = bytes.readUInt32LE(at);
    if (magic >>> 4 === 0x184d2a5) {
      // A skippable frame: magic, a 4-byte size, that many bytes.
      if (at + 8 > bytes.length) return false;
      at += 8 + bytes.readUInt32LE(at + 4);
      if (at > bytes.length) return false;
      continue;
    }
    if (magic !== 0xfd2fb528) return false;
    at += 4;
    if (at >= bytes.length) return false;
    const fhd = bytes[at]!;
    at += 1;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    if ((fhd >> 3) & 1) return false; // the reserved bit
    const checksum = (fhd >> 2) & 1;
    at += singleSegment ? 0 : 1; // window descriptor
    at += [0, 1, 2, 4][fhd & 3]!; // dictionary id
    at += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!; // frame content size
    for (;;) {
      if (at + 3 > bytes.length) return false;
      const header = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
      at += 3;
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      if (type === 3) return false;
      at += type === 1 ? 1 : size;
      if (at > bytes.length) return false;
      if (last) break;
    }
    at += checksum ? 4 : 0;
    if (at > bytes.length) return false;
  }
  return true;
}

/** Read an archive's bytes: every regular file a member, in archive order, or the first reason it cannot be read. */
export function readArchive(bytes: Buffer): ArchiveReading {
  if (!wholeZstdFrames(bytes)) return { ok: false, reason: "zstd" };
  let tar: Buffer;
  try {
    tar = zstdDecompressSync(bytes);
  } catch {
    return { ok: false, reason: "zstd" };
  }
  const members: Member[] = [];
  let longName: string | undefined;
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) {
      // The end of the data without the two zero blocks is accepted only on a block boundary.
      if (at === tar.length && at > 0) break;
      return { ok: false, reason: "tar" };
    }
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) return { ok: false, reason: "tar" };
    const size = octal(h, 124, 12);
    if (size === undefined) return { ok: false, reason: "tar" };
    const start = at + BLOCK;
    if (start + size > tar.length) return { ok: false, reason: "tar" };
    const data = tar.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(h[156]!);
    const prefix = field(h, 345, 155);
    const headerName = (prefix !== "" && field(h, 257, 6) === "ustar" ? `${prefix}/` : "") + field(h, 0, 100);
    const name = longName ?? headerName;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "g") continue;
    longName = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") return { ok: false, reason: "tar", member: name };
    const member = decode(name, data);
    if ("ok" in member) return member;
    members.push(member);
  }
  return { ok: true, members };
}
