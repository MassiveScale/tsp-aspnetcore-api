# Development

## Setup

```bash
npm install
npm run build   # tsc src/ + tsc test/ + copy templates
npm test        # builds first, then runs node --test on dist/
```

## Commands

| Command                | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `npm run build`        | Compile TypeScript and copy Handlebars templates to `dist/`. |
| `npm test`             | Build then run all end-to-end tests via `node --test`.       |
| `npm run format`       | Format files with Prettier.                                  |
| `npm run format:check` | Check formatting without changing files.                     |
| `npm run lint`         | Lint source and test files with ESLint.                      |

## VS Code testing

Tests are written in TypeScript under `test/` and compiled to `dist/test/*.test.js`. Run `npm run build` (or `npm test`, which builds first) so the VS Code Testing panel discovers the compiled tests.

Recommended VS Code extensions for test discovery and test UI integration:

- `hbenl.vscode-test-explorer`
- `connor4312.nodejs-testing`

## Project structure

```
src/
  emitter.ts        # $onEmit entrypoint; option resolution; resolves HTTP services once
  models.ts         # model, interface and enum emit
  controllers.ts    # controller emit
  services.ts       # service interface emit
  helpers.ts        # MergePatch, EnumMemberConverter and BooleanStringJsonConverter emit
  validators.ts     # FluentValidation validator emit
  payloads.ts       # decides which models get a class
  clean.ts          # removes stale generated files
  lib.ts            # EmitterOptions interface + JSON Schema; $lib registration
  renderer.ts       # Handlebars template loading and rendering
  utils.ts          # SCALAR_MAP, FORMAT_MAP, pascalCase, camelCase, ordinalCompare
  templates/        # Handlebars templates for all generated C# artifacts (LF line endings)
test/               # End-to-end tests (Node --test)
```

The test suite runs in CI against both the latest and the minimum supported versions of the `@typespec/*` peer dependencies.
