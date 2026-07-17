# Core Concepts

## Prediction inversion

A prediction declares the **complete observable footprint** of an operation across every
configured service. The test asserts both directions:

- **Missing** — predicted but not captured → failure.
- **Unpredicted** — captured but not predicted → failure.

`has []` is an explicit zero-assertion, and every configured service must appear in every
prediction (omission is ambiguity, and ambiguity is an error). A rejection prediction asserts an
error response **and zero effects across all services** — business rules that refuse must leave
no trace.

## The dual zones

A `.feat` file has two kinds of content, visually and grammatically distinct:

| Zone | Sections | Rules |
| --- | --- | --- |
| **Agent zone** | `construct:`, `enforce:` | Freeform natural language. Recognized line keywords produce structure; everything else is captured verbatim as directives. A parse error here is impossible. |
| **Compiler zone** | `contract:`, `scenario`, `predict` | Strict typed grammar. Malformation is a parse error, never a silent failure. |

Inside compiler-zone blocks, **every bare word is a keyword or a validated identifier — nothing
is prose**.

## The four closed reference spaces

Nothing in a spec references anything undeclared:

1. **Service keys** → must exist in `feat.config.json` `services`.
2. **Schema names** → must be declared in the spec's `contract:` block.
3. **Command names** → must be routed in `response.commands`.
4. **Actor names** → must exist in `response.actors` (`anonymous` is reserved).

All four are enforced at parse time with errors that list the valid names. This is type safety
for specifications.

## The agent contract

The spec is a contract between its author and whoever builds it — human or agent:

- **`status` lifecycle**: `draft → agreed → built → verified`. Nothing gets built before
  `agreed`; tooling (not people) flips `built` and `verified`.
- **`touches` change boundaries**: the build may create or modify only matching paths — the
  build-time mirror of prediction inversion. Always required.
- **`rejects <ID> when <reason>`**: every predicted rejection must be justified in the build
  instructions, and every justification must be tested — checked in both directions.
- **Ambiguity protocol**: a builder that finds an instruction ambiguous halts and asks. It never
  guesses.

## Determinism

Three invariants make the CI gate possible: same spec + config → identical IR (parse), identical
topology (derive), identical test file byte-for-byte (emit). Generated files carry no timestamps —
their header holds a hash of the inputs. `feat verify` is a plain byte comparison.

## Golden fixtures and the corpus

`equals fixture "<path>"` asserts deep structural equality against a JSON fixture, validated
against the position's schema at compile time. The repository's `corpus/` applies this idea to
the language itself: each exemplar pairs a `.feat` file with its expected IR, making the corpus
the parser's executable contract. Every language change must land with a corpus exemplar — a rule
earned the hard way, twice.
