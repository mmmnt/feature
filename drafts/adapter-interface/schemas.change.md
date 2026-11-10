# DRAFT — schema changes (Layer 4 of the `fault` language change, plus the config overlay)

## schemas/builtspec.schema.json (Layer 4: the IR)

In `definitions.given.properties` add (alongside `clock`, `context`, `executes`, `seeds`):

```json
"faults": {
  "type": "array",
  "description": "Logical faults the named service's adapter arms as preconditions, in written order (ADR-0023). Armed after seeds and executes, before the capture window.",
  "items": { "$ref": "#/definitions/fault" }
}
```

and add to `definitions`:

```json
"fault": {
  "type": "object",
  "additionalProperties": false,
  "required": ["service", "operation", "fault", "times"],
  "properties": {
    "service":   { "type": "string", "description": "A configured service key (INV-7)." },
    "operation": { "type": "string", "pattern": "^[A-Z][A-Za-z0-9]*$" },
    "fault":     { "type": "string", "pattern": "^([A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]*)$" },
    "detail":    { "type": "object", "description": "Literal data for the adapter; no matchers." },
    "times":     { "oneOf": [ { "type": "integer", "minimum": 1 }, { "const": "reset" } ],
                   "description": "Consumption: n calls (1 is the default, `once`), or \"reset\" for until the case ends. Always emitted." }
  }
}
```

Verified: `corpus given-fault.ir.json` validates against the schema with exactly this patch and is
rejected by today's schema (`additionalProperties: faults`); see DESIGN.md "Validation".

## packages/feat-types/src/index.ts

```ts
export interface Fault {
  service: string;
  operation: string;
  fault: string;
  detail?: Record<string, unknown>;
  times: number | "reset";
}
export interface Given { /* … */ faults?: Fault[]; }
```

## schemas/feat.config.schema.json

Add to the top-level `properties`:

```json
"extends": { "type": "string", "minLength": 1,
             "description": "Tier overlay (ADR-0024): the base config this file overrides. Relative to this file." }
```

relax the root `required` (`schemas`, `services`, `specs`) to be satisfied after `extends` is
resolved (the loader validates the MERGED document; an overlay file alone need not carry
`schemas`), add `specs.exclude` (`array` of `string`).

(No `observes` key in config: the adapter declares what it serves; a project cannot claim a
mode the adapter lacks.)
