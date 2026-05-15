## Project Purpose
This project is a TypeSpec emitter that generates models, controllers, services, and validators for an ASP.NET Core API. 

## Technical Conventions
- Keep emitter implementation under `src/`.
- Keep Handlebars templates as external `.hbs` files under `templates/`.
- Avoid embedding large templates directly in TypeScript files.
- Prefer focused, incremental changes over broad refactors.
- Always update the README file when behavior or options change.
- When documenting configuration options, sort them alphabetically by option name.
- Maintain CHANGELOG.md with notable changes.
- After any code changes, run tests and compile the example projects.

# Code Style
- Always annotate exported code with JSDoc comments.
- Add inline comments only for non-obvious or complex logic.

# Specifications / Description
- This project is a C# emitter for TypeSpec.
- TypeSpec: https://typespec.io
- TypeSpec repository: https://github.com/microsoft/typespec

## Testing Expectations
- Tests should be Node built-in tests in `test/*.test.js` so VS Code test discovery can find them.
- Keep tests end-to-end where possible by compiling TypeSpec source and asserting generated outputs.
- Cover:
  - default markdown generation,
  - multiple service namespaces.

# Specifications / Description
- This project is a C# emitter for TypeSpec.
- TypeSpec: https://typespec.io
- TypeSpec repository: https://github.com/microsoft/typespec

# Emitter Conventions
- Default output directory for model and interface files is Models.
- Default output directories for other artifacts are Controllers, Services, Validators, and Helpers.
- When namespace-from-path is true, generated namespaces must reflect output directory paths for all generated artifacts.
- Generated using directives must include referenced namespaces and any configured additional-usings.
- The emitter must support both explicit enums and inferred enums from string-literal unions.
- MergePatchUpdate models must preserve strong typing (for example, MergePatchValue<WidgetColor?>, not object fallbacks).

## Validation
- After code changes, run:
  - `npm run build`
  - `npm test`
- After code changes, rebuild the example typespec projects under `examples/`

> [IMPORTANT!]
> Always update the CHANGELOG and README after making changes

