# Development

## Setup

```bash
npm install
npm run build   # tsc src/ + tsc test/ + copy templates
npm test        # builds first, then runs node --test on dist/
```

## Commands

| Command              | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `npm run build`      | Compile TypeScript and copy Handlebars templates to `dist/`. |
| `npm test`           | Build then run all end-to-end tests via `node --test`.       |
| `npm run test:vscode`| VS Code-friendly test entrypoint (`test/*.test.mjs`).        |
| `npm run format`     | Format source files with Prettier.                           |
| `npm run lint`       | Lint source files with ESLint.                               |

## VS Code testing

The repository includes `test/aspnetcore.api.test.mjs` as a Node test entrypoint so the VS Code Testing panel can discover tests reliably.

`npm test` runs `pretest` automatically, so compiled tests in `dist/test` are refreshed before execution.

Recommended VS Code extensions for test discovery and test UI integration:

- `hbenl.vscode-test-explorer`
- `connor4312.nodejs-testing`

## Project structure

```
src/
  emitter.ts        # $onEmit entrypoint; option resolution; model/enum/interface/validator emit
  controllers.ts    # controller and service interface emit
  lib.ts            # EmitterOptions interface + JSON Schema; $lib registration
  renderer.ts       # Handlebars template loading and rendering
  utils.ts          # SCALAR_MAP, FORMAT_MAP, pascalCase, camelCase
  templates/        # Handlebars templates for all generated C# artifacts
test/               # End-to-end tests (Node --test)
```
