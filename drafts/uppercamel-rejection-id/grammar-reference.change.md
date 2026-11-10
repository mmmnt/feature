# DRAFT — grammar-reference change for ADR-0022 (UpperCamel rejection ids)

Layer 1 of 4 (grammar reference). Apply to `docs/grammar-reference.md` only after the founder flips
`packages/feat-core/parse.feat` (the amendment beside this file) to `agreed`. Bump the title to
"Grammar Reference v1.2" and the header line to "ADR-0001…0022". The language version stays
`feat 1.0`: the change only widens what was accepted, so every v1.0 file still parses (additive
minor rule, ADR-0005).

## 1. §1.2 Lexical rules — add a bullet

> - **Rejection ids** (ADR-0022): the `<ID>` of `rejects <ID> when …` and `predict rejection <ID>:`
>   is one token, either **UPPER_SNAKE** (`[A-Z0-9_]+`, e.g. `UNIQUE_NAME`) or **UpperCamel**
>   (`[A-Z][A-Za-z0-9]*`, e.g. `NotOperator`). The two forms are both valid and may be mixed in one
>   spec. An id is kept verbatim and compared **case-sensitively and exactly**: `NotOperator` and
>   `NOT_OPERATOR` are two different ids. Anything else in the id position of a `predict rejection`
>   line (`notOperator`, `Not_Operator`, `not-operator`) is a `MALFORMED_SYNTAX` parse error whose
>   hint names both valid forms. A `rejects` line whose id is not valid is, as before, an opaque
>   enforce-zone constraint; the two-way lint (B2) then reports the predicted id with no `rejects`.

## 2. §3.2 `enforce:` — replace the `rejects` table row

Before:

> | `rejects` | `rejects UNIQUE_NAME when a flow with this name exists for the tenant` | Justifies a business-rule rejection. `<ID>` is typed (KEYWORD position, validated two-way against scenario rejection IDs); the reason is FREEFORM. |

After:

> | `rejects` | `rejects UNIQUE_NAME when a flow with this name exists for the tenant` · `rejects NotOperator when the caller is not an operator` | Justifies a business-rule rejection. `<ID>` is typed (KEYWORD position; UPPER_SNAKE or UpperCamel, §1.2; validated two-way, case-sensitively, against scenario rejection IDs); the reason is FREEFORM. |

## 3. §5.3 `predict` table — replace the `predict rejection` row

Before:

> | `predict rejection <ID>:` | Error response + **zero effects across ALL configured services** |

After:

> | `predict rejection <ID>:` | Error response + **zero effects across ALL configured services**. `<ID>` is UPPER_SNAKE or UpperCamel (§1.2). |

`predict error <CODE>:` is unchanged (UPPER_SNAKE only) pending the founder's answer to question 2
of the ADR-0022 rulings workshop.

## 4. §5.6 Scenario outlines — one sentence

After "…the two-way lint evaluates per expanded row)" add: "A row value is a rejection id in either
form; it is compared exactly."

## 5. §9 Reserved keyword summary — no change (ids are not keywords).

## 6. Corpus README (layer 2) — add a row

> | 13 | `rejection-camelcase/` | SPEC-REJ-001 | UpperCamel rejection ids (ADR-0022): `rejects NotOperator`, `rejects AlreadyAnswered`, `predict rejection NotOperator:` beside an UPPER_SNAKE id (`UNKNOWN_QUESTION`) in one spec; actors (`as operator` / `as reader`); ids kept verbatim in the IR |

(The README's table numbering is already out of order after row 10; fix it in the same change.)

## 7. Parser (layer 3) — what the change is, for the implementer after the flip

- `packages/feat-core/src/parse.ts` line ~553: `[A-Z0-9_]+` → `(?:[A-Z][A-Za-z0-9]*|[A-Z0-9_]+)`.
- line ~620: the id group `[A-Z0-9_]+|<…>` → `(?:[A-Z][A-Za-z0-9]*|[A-Z0-9_]+)|<…>`, for the `rejection`
  alternative only; `predict error` keeps `[A-Z0-9_]+` (question 2).
- the `MALFORMED_SYNTAX` hint for an unknown prediction form names both id forms.
- Sweep for siblings in the same change (sweep, never enumerate): the three TextMate grammars —
  `editor/feat.tmLanguage.json` lines 63 and 87 hold `[A-Z0-9_]+` and must widen;
  `editors/vscode/syntaxes/` and `packages/feat-grammar/` already accept `[A-Za-z0-9_-]` — plus
  `packages/feat-grammar/tokenize.test.ts` (add an UpperCamel scope assertion).
- No change needed (verified by reading): `schemas/builtspec.schema.json` (`rejectionId` is an
  unconstrained string), `feat-derive` (placeholder substitution is `String(row[…])`),
  `feat-analyze` B2 (set equality on exact strings, so case-sensitive already).

## 8. Re-validation (layer 4)

`pnpm corpus:validate`, the corpus-sweeping tests (`parse-source-parity`, `invariants`, which pick
the new exemplar up by directory), the SPEC-CORE-001 generated suite, then the CI chain
`feat lint → feat generate → feat audit → feat run`.
