# ADR-0030 — the f32 digest matcher `f32 <dims> sha256 "<hex>"`

Status: Accepted (founder ruling 2026-11-16, "New Feature matcher (Recommended)"; agreed 2026-11-16, "Agree as
drafted (Recommended)"). Built in SPEC-CORE-001 (amended) and SPEC-RT-014 (new).

## Context

A consumer stores an embedding: an array of a few hundred numbers produced by a pinned encoder. The
consumer has shown that the encoder is reproducible bit for bit, so a spec can and should predict the exact
vector. No matcher states it usably:

- a literal (or `equals fixture`) is exact but means 384 numbers per prediction, which no reviewer reads;
- `any` pins nothing, so an encoder that drifts, or returns zeros, passes;
- a rounded or tolerance form would be weaker than the reproducibility the consumer proved.

An exact digest of the values is as strict as the literal and one line long.

## Decision

1. A matcher may be written `f32 <dims> sha256 "<hex>"`, e.g. `embedding: f32 384 sha256 "9c1e…4a"`.
   It passes when the field is present, is an array of exactly `<dims>` numbers, each number is exactly
   representable as an IEEE-754 single (`Math.fround(x) === x`), and the sha256 of the values written as
   consecutive 4-byte little-endian f32s equals `<hex>`.
2. Each check is a violation, never a pass, in this order, the first failing one reported (digests are
   shortened here; a violation shows them in full):
   - absent: `expected f32 384 sha256 "9c1e…4a", field is absent`;
   - not an array of numbers: `expected an array of 384 f32 values, got <JSON, truncated>`;
   - wrong length: `expected 384 f32 values, got 512`;
   - a value that is not an f32: `value [17] = 0.1 is not an f32 (the nearest f32 is 0.10000000149011612)` —
     an f64 value would otherwise be rounded silently before hashing, and two different arrays would share a
     digest;
   - the digest: `expected f32 sha256 "9c1e…4a", got "77b0…01"` (both digests in full in the message).
3. The parser refuses, as `MALFORMED_SYNTAX` with a hint:
   - `<dims>` that is not a positive integer (`f32 0 …`, `f32 -3 …`, `f32 1.5 …`);
   - a digest that is not 64 lowercase hexadecimal characters, or not a string;
   - `f32` without `<dims>`, without `sha256`, or without the digest;
   - `not f32 …`: a negated digest passes on every other array, which pins nothing; write the digest the
     value should have.
   The IR schema refuses the same shapes, so a hand-written IR cannot carry them either.
4. The IR is `{ "matcher": "f32Digest", "dims": <int>, "sha256": "<64 lowercase hex>" }`.
5. The matcher stands in a value block's field position only (like `not`); it is not a `response`/record
   form. An outline placeholder is not accepted for the digest or the dims in this change (each row of an
   outline would carry its own literal digest anyway; add it when a consumer needs it).
6. `f32` and `sha256` are reserved in a value block's matcher position only. The language stays `feat 1.0`:
   the change is additive, every existing spec parses to the same IR, and the adapter interface and the Feat
   Host Protocol are unchanged.

## The amendment to SPEC-CORE-001

> AMENDMENT (ADR-0030, the f32 digest matcher). A value block's matcher may be `f32 <dims> sha256 "<hex>"`,
> recorded as { matcher: "f32Digest", dims, sha256 }; the runtime evaluates it (SPEC-RT-014). One new
> exemplar, corpus/f32-digest, and refusal fixtures for a non-positive or fractional dims, a malformed
> digest, a missing part, and `not f32 …`; every other scenario and every other exemplar's IR is unchanged.

Construct: "In a value block's matcher position, `f32` followed by a positive integer, `sha256` and a string of
64 lowercase hexadecimal characters is the f32 digest matcher (ADR-0030), recorded as { matcher:
"f32Digest", dims, sha256 }. Any other shape after `f32`, and `not f32 …`, is MALFORMED_SYNTAX with a hint."

## Rejected alternatives

- **Exact literals / a golden fixture of the values.** Exact, but unreadable at 384 values a prediction, and
  a fixture file per vector moves the prediction out of the spec.
- **A tolerance or rounded form (`approx [...] tol 1e-4`).** Weaker than the proven bit-for-bit encoder: a
  drift below the tolerance passes.
- **Hashing f64 bytes, or the JSON text.** f64 bytes differ from what the encoder produced (f32) and invite
  an f64 value to pass unnoticed; JSON text depends on number formatting. The f32 little-endian bytes are
  the encoder's own output.
- **Digest without a length.** A truncated or padded array is the common failure; the length makes it a
  readable violation instead of a bare digest mismatch, and states the shape in the spec.
- **The consumer records a digest instead of the array.** Moves the hashing into the system under test, so
  the prediction stops describing what the store holds, and diverges from what an observing adapter reads.

## Consequences

- `schemas/builtspec.schema.json` gains the `f32Digest` matcher; `@mmmnt/feat-types` gains it in `Matcher`;
  the parser (feat-core) and the runtime's `applyMatcher` (node `crypto` sha256) implement it; the
  TextMate grammars scope `f32` and `sha256` as matcher words. derive is unchanged (no placeholders).
- A suite generated before this change never contains the matcher, so nothing regenerates for it.
- The corpus gains exemplar `corpus/f32-digest/`.
