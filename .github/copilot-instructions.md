## Project Purpose

`@massivescale/tsp-aspnetcore-api` is a TypeSpec emitter that generates C# models,
interfaces, enums, ASP.NET Core controllers, service interfaces, FluentValidation
validators, and helper types from TypeSpec definitions.

- TypeSpec docs: https://typespec.io
- TypeSpec repo: https://github.com/microsoft/typespec

---

## Architecture

| File / directory      | Role                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/lib.ts`          | `EmitterOptions` interface + `EmitterOptionsSchema` (JSON Schema) + `$lib` registration                  |
| `src/emitter.ts`      | `$onEmit` entrypoint; `resolveOptions`; `ResolvedOptions`; resolves HTTP services once per emit          |
| `src/models.ts`       | Model, interface and enum emit                                                                           |
| `src/controllers.ts`  | Controller collection and emit                                                                           |
| `src/services.ts`     | Service interface emit                                                                                   |
| `src/helpers.ts`      | `MergePatch`, `EnumMemberConverter` and `BooleanStringJsonConverter` helper emit                         |
| `src/validators.ts`   | FluentValidation validator and `ValidatorsInitializer` emit                                              |
| `src/clean.ts`        | Removes stale generated files before emit (`clean-output-dirs`)                                          |
| `src/payloads.ts`     | Decides which models get a class via `@typespec/http` (response / metadata-only models, implicit bodies) |
| `src/naming.ts`       | `csharpModelName` — the single source of C# class names, incl. per-instantiation template names          |
| `src/renderer.ts`     | Handlebars setup; `TemplateName` union; `TemplateOverrides` type; `createRenderer`                       |
| `src/utils.ts`        | `SCALAR_MAP`, `FORMAT_MAP`, `pascalCase`, `camelCase`, `ordinalCompare` — shared utilities               |
| `src/templates/*.hbs` | Handlebars templates for every generated C# artifact (LF line endings, enforced by `.gitattributes`)     |
| `test/*.test.ts`      | End-to-end tests, one file per area (TypeScript source, compiled to `dist/test/`)                        |
| `test/host.ts`        | `emit()` and `emitWithDiagnostics()` test helpers                                                        |
| `docs/`               | Per-topic documentation linked from README                                                               |

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

Every output section has one flat C# namespace, set verbatim by its option:
`models-namespace` (also used by interfaces and enums), `controllers-namespace`,
`services-namespace`, `validators-namespace` and `helpers-namespace`. When an option is unset, the
namespace is the effective root namespace plus the section name (`<root>.Models`,
`<root>.Controllers`, …). The effective root is `root-namespace` when set, otherwise inferred from the
TypeSpec namespace tree (`inferRootNamespace`). There are no `*-root-namespace` options.

`namespace-from-path` controls **file placement only** for models, interfaces and enums: `false`
(the default) places files in subdirectories that mirror the TypeSpec namespace (after
`namespace-map` rewrites) below the root namespace; `true` writes them flat into the output directory.
It never changes the C# namespace written into a file.

---

## Testing

- Source: `test/*.test.ts` → compiled by `tsc` to `dist/test/*.test.js`.
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

Alwasys update the documentation after any change.

---

## Validation Checklist

Run all of these after any change:

```bash
npm run format
npm run build          # TypeScript compilation
npm test               # all tests must pass, 0 failures
npm run lint           # no lint errors
npm run format:check   # no formatting violations
```

Always rebuild all example projects under `example/`.
