// Compile-time JSON Schema bundling — the mechanism behind ResolvedSchema.normalized.
//
// Why this exists: a resolved schema is inlined into a generated test that lives in a
// different directory than the contract it came from, and nothing resolves at run time.
// A relative `$ref` authored against `contracts/identity/` means nothing once the document
// is sitting next to the spec — the base URI is lost in transit. Every cross-file
// reference must therefore be followed here, against the SOURCE file's base URI.
//
// Bundling, not flattening: each referenced document is relocated ONCE into the bundle
// root's `$defs` and pointed at from every site that wanted it, so shared targets stay
// shared and reference cycles terminate (a document is registered at its destination
// BEFORE its own references are rewritten). Pointers the root already owned
// (`#/$defs/...`) are left exactly as authored.
//
// Relocated documents drop `$id` and `$schema`: a nested `$id` would re-base every
// pointer inside the bundle, and the embedded copy is no longer a document in its own
// right. The bundle root keeps both — it IS the document.

import { readFileSync } from "node:fs";
import path from "node:path";

type Json = unknown;
type Obj = Record<string, unknown>;

export interface Bundled {
  /** Absolute path (plus pointer, if any) of the document the bundle root came from. */
  id: string;
  /** The verbatim node the reference landed on — no rewriting. */
  raw: Json;
  /** Self-contained schema: no `$ref` leaves the document. */
  schema: Obj;
}

/** A `$ref` target we cannot reach through the filesystem (http:, urn:, …). */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Traversal is keyword-aware: `$ref` is only a reference in a schema position. A property
// literally named "$ref" (`properties: { "$ref": … }`) or an `enum`/`const` value that
// happens to hold one is data, and rewriting it would corrupt the contract.
const SCHEMA_KEYWORDS = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if",
  "items", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs", "definitions", "dependencies", "dependentSchemas", "patternProperties", "properties",
]);

function isObj(v: Json): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

interface Loc {
  /** Absolute path of the file the reference lands in. */
  file: string;
  /** JSON pointer within that file; "" is the document root. */
  pointer: string;
}

class Bundler {
  private readonly docs = new Map<string, Json>();
  /** absolute file → JSON-pointer prefix of where it lives in the output ("" = the root). */
  private readonly placement = new Map<string, string>();
  private readonly defs: Obj = {};
  private readonly usedKeys = new Set<string>();

  private load(file: string): Json {
    if (this.docs.has(file)) return this.docs.get(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(`Schema resolution: referenced schema file '${file}' could not be read.`);
    }
    let doc: Json;
    try {
      doc = JSON.parse(text) as Json;
    } catch (cause) {
      throw new Error(`Schema resolution: '${file}' is not valid JSON: ${(cause as Error).message}`);
    }
    this.docs.set(file, doc);
    return doc;
  }

  /** Split a reference into the file it names and the pointer inside it. */
  private locate(ref: string, fromFile: string): Loc {
    const hash = ref.indexOf("#");
    const filePart = hash === -1 ? ref : ref.slice(0, hash);
    const fragment = hash === -1 ? "" : ref.slice(hash + 1);
    if (fragment !== "" && !fragment.startsWith("/"))
      throw new Error(
        `Schema resolution: '${ref}' (from ${fromFile}) uses a plain-name fragment; ` +
          `only JSON-pointer fragments are supported.`,
      );
    return {
      file: filePart === "" ? fromFile : path.resolve(path.dirname(fromFile), filePart),
      pointer: fragment,
    };
  }

  private deref(loc: Loc): Json {
    let cur = this.load(loc.file);
    if (loc.pointer === "") return cur;
    for (const token of loc.pointer.split("/").slice(1)) {
      const key = unescapeToken(token);
      cur = Array.isArray(cur) ? cur[Number(key)] : isObj(cur) ? cur[key] : undefined;
      if (cur === undefined)
        throw new Error(
          `Schema resolution: pointer '#${loc.pointer}' does not resolve in ${loc.file}.`,
        );
    }
    return cur;
  }

  /** Stable, collision-free `$defs` key for a relocated document. */
  private allocKey(file: string): string {
    const stem =
      path.basename(file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_") || "schema";
    let key = stem;
    for (let n = 2; this.usedKeys.has(key); n++) key = `${stem}_${n}`;
    this.usedKeys.add(key);
    return key;
  }

  /**
   * Ensure `file` lives somewhere in the bundle and return its pointer prefix. The
   * placement is recorded BEFORE the document's own references are rewritten, so a cycle
   * (A → B → A) finds A already placed instead of recursing forever.
   */
  private place(file: string): string {
    const existing = this.placement.get(file);
    if (existing !== undefined) return existing;

    const key = this.allocKey(file);
    this.placement.set(file, `/$defs/${key}`);
    this.defs[key] = {}; // reserve the slot now: key order follows discovery order

    const doc = this.load(file);
    if (!isObj(doc)) throw new Error(`Schema resolution: '${file}' is not a JSON Schema object.`);

    const rewritten = this.rewriteSchema(doc, file, false, true) as Obj;
    delete rewritten["$id"];
    delete rewritten["$schema"];
    this.defs[key] = rewritten;
    return `/$defs/${key}`;
  }

  private rewriteRef(ref: string, file: string, nestedId: boolean): string {
    const filePart = ref.split("#")[0] ?? "";
    // Not a filesystem target — leave it exactly as authored rather than guess.
    if (filePart !== "" && ABSOLUTE_URI.test(filePart)) return ref;
    if (nestedId)
      throw new Error(
        `Schema resolution: '${ref}' in ${file} sits under a subschema that declares its own ` +
          `$id, which re-bases relative references — unsupported. Give the subschema its own file.`,
      );
    const target = this.locate(ref, file);
    const pointer = `${this.place(target.file)}${target.pointer}`;
    return pointer === "" ? "#" : `#${pointer}`;
  }

  private rewriteSchema(node: Json, file: string, nestedId: boolean, atDocRoot = false): Json {
    if (Array.isArray(node)) return node.map((n) => this.rewriteSchema(n, file, nestedId));
    if (!isObj(node)) return structuredClone(node); // boolean schemas and plain data
    const inner = nestedId || (!atDocRoot && typeof node["$id"] === "string");

    const out: Obj = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out[key] = this.rewriteRef(value, file, inner);
      else if (SCHEMA_KEYWORDS.has(key)) out[key] = this.rewriteSchema(value, file, inner);
      else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value))
        out[key] = value.map((n) => this.rewriteSchema(n, file, inner));
      else if (SCHEMA_MAP_KEYWORDS.has(key) && isObj(value)) {
        const map: Obj = {};
        for (const [name, sub] of Object.entries(value)) map[name] = this.rewriteSchema(sub, file, inner);
        out[key] = map;
      } else out[key] = structuredClone(value);
    }
    return out;
  }

  run(ref: string, fromPath: string): Bundled {
    const loc = this.locate(ref, path.resolve(fromPath));
    const node = this.deref(loc);
    if (!isObj(node))
      throw new Error(
        `Schema resolution: '${ref}' (from ${fromPath}) does not point at a JSON Schema object.`,
      );

    // Reserve the `$defs` keys the root already owns before relocating anything into it,
    // and record the root's own file as the bundle root so refs back to it stay "#…".
    const rootDefs = node["$defs"];
    if (isObj(rootDefs)) for (const key of Object.keys(rootDefs)) this.usedKeys.add(key);
    if (loc.pointer === "") this.placement.set(loc.file, "");

    const out = this.rewriteSchema(node, loc.file, false, loc.pointer === "") as Obj;
    if (Object.keys(this.defs).length > 0) {
      // Assigning an existing key keeps its position, so a root that already had `$defs`
      // keeps it where the author put it — emit stays byte-identical for identical input.
      out["$defs"] = { ...(isObj(out["$defs"]) ? out["$defs"] : {}), ...this.defs };
    }

    return {
      id: `${loc.file}${loc.pointer === "" ? "" : `#${loc.pointer}`}`,
      raw: node,
      schema: out,
    };
  }
}

/**
 * Resolve `ref` against `fromPath`'s base URI and return a self-contained bundle.
 * `ref` is an ordinary JSON Schema reference: a relative file path, a `#/pointer` into
 * `fromPath` itself, or both.
 */
export function bundle(ref: string, fromPath: string): Bundled {
  return new Bundler().run(ref, fromPath);
}
