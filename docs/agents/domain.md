# Domain docs

This repository uses a single-context documentation layout.

Before exploring or changing a domain area, read:

- `CONTEXT.md` at the repository root for shared terminology, component boundaries, and safety constraints.
- `USAGE.md` at the repository root for the user-facing integration, operation, and extension contract.
- Relevant decisions under `docs/adr/` when that directory exists.

Use terms defined in `CONTEXT.md` in issues, tests, implementation, and design discussions. If an existing ADR conflicts with proposed work, surface the conflict explicitly instead of silently overriding it.

Every user-visible feature change must update `USAGE.md`. Update `CONTEXT.md` as well when the change affects terms, component boundaries, or safety invariants.

## Layout

```text
/
├── CONTEXT.md
├── USAGE.md
├── docs/
│   ├── adr/
│   └── agents/
└── packages/
```
