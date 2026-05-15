## Project Purpose

`@massivescale/tsp-aspnetcore-api` is a TypeSpec emitter that generates C# models,
interfaces, enums, ASP.NET Core controllers, service interfaces, FluentValidation
validators, and helper types from TypeSpec definitions.

- TypeSpec docs: https://typespec.io
- TypeSpec repo: https://github.com/microsoft/typespec

---

## Architecture

| File / directory | Role |
|---|---|
| `src/lib.ts` | `EmitterOptions` interface + `EmitterOptionsSchema` (JSON Schema) + `$lib` registration |
| `src/emitter.ts` | `$onEmit` entrypoint; `resolveOptions`; `ResolvedOptions`; model / enum / interface / validator emit |
| `src/controllers.ts` | Controller and service interface collection and emit |
| `src/renderer.ts` | Handlebars setup; `TemplateName` union; `TemplateOverrides` type; `createRenderer` |
| `src/utils.ts` | `SCALAR_MAP`, `FORMAT_MAP`, `pascalCase`, `camelCase` — shared utilities |
| `src/templates/*.hbs` | Handlebars templates for every generated C# artifact |
| `test/aspnetcore.api.test.ts` | End-to-end tests (TypeScript source, compiled to `dist/test/`) |
| `test/host.ts` | `emit()` and `emitWithDiagnostics()` test helpers |
| `docs/` | Per-topic documentation linked from README |

---

## Code Style

- All exported symbols must have JSDoc comments.
- Inline comments only for non-obvious logic, hidden constraints, or surprising invariants.
- Use the `node:` module-protocol prefix on built-in imports (`node:fs`, `node:path`, etc.).
- TypeScript: prefer `const`; avoid `any`.

---

## Adding or Removing Emitter Options

**All five steps are required.** Missing step 2 causes TypeScript error TS2322.

1. Update the `EmitterOptions` interface in `src/lib.ts`.
2. Update `EmitterOptionsSchema` in `src/lib.ts` — the JSON Schema properties block must exactly mirror the interface.
3. Add the resolved value to `ResolvedOptions` in `src/emitter.ts`.
4. Compute and assign it in `resolveOptions()` in `src/emitter.ts`.
5. Add a row to the README options table (alphabetical by option name) and update `docs/` as needed.

---

## Adding a New Template-Rendered Artifact

**All six steps are required.**

1. Add the key to the `TemplateName` union in `src/renderer.ts`.
2. Add the key with JSDoc to `TemplateOverrides` in `src/lib.ts`.
3. Add the key to the `templates` properties block in `EmitterOptionsSchema` in `src/lib.ts`.
4. Add the key to the `keys` array in `resolveTemplatePaths()` in `src/emitter.ts`.
5. In the emit function, pass `options.templates["key"]` to the template getter so user overrides are honoured.
6. Add the key to the Available template keys table in `docs/custom-templates.md`.

---

## Namespace Resolution

Two strategies apply to different output sections:

**Models, interfaces, enums** — namespace derived from the TypeSpec namespace (after `namespace-map`
rewrites), with an optional PascalCased dir suffix appended when `namespace-from-path` is `true`.
Fallback for top-level unnamespaced types: `sectionRootNs` → `root-namespace` → `"Models"`.

- Models use `modelsEffectiveRootNs` as their `sectionRootNs`.
- Interfaces use `interfacesEffectiveRootNs` — computed **separately** from `modelsEffectiveRootNs` — so `interfaces-root-namespace` correctly overrides the interface namespace even when `models-root-namespace` is not set.

**Controllers, services, validators, helpers** — always path-derived via `pathNamespace(rootNs, dir)`.
Section-specific root overrides available: `controllers-root-namespace`, `services-root-namespace`,
`validators-root-namespace`. There is no `helpers-root-namespace`.

---

## Testing

- Source: `test/aspnetcore.api.test.ts` → compiled by `tsc` to `dist/test/aspnetcore.api.test.js`.
- Run with `npm test` (triggers `pretest` = build automatically).
- Use `emit(typespecSource, options?)` from `test/host.ts` — returns `Record<string, string>` mapping output path to generated C# content.
- The `emit()` helper proxies bare filenames to `Models/<file>` when no explicit `models-output-dir` is set, preserving backward compatibility in tests.
- Tests are end-to-end: compile TypeSpec and assert generated file contents.
- Group tests with `describe()` blocks. Cover the happy path, option interactions, and edge cases for every feature.
- Do **not** mock the TypeSpec compiler or file system — compile real TypeSpec source.

---

## Documentation

- `README.md` — overview, quick start, and the full options table (sorted alphabetically).
- `docs/` — one file per topic (type-mapping, models, namespace-resolution, controllers-and-services, merge-patch, validators, custom-templates, contributing). Update the relevant doc(s) when behavior changes.
- `CHANGELOG.md` — maintain the `[Unreleased]` section with all notable changes.

---

## Validation Checklist

Run all of these after any change:

```bash
npm run build          # TypeScript compilation
npm test               # all tests must pass, 0 failures
npm run lint           # no lint errors
npm run format:check   # no formatting violations
```

If emitter behavior changed, also rebuild the example TypeSpec projects under `example/`.
