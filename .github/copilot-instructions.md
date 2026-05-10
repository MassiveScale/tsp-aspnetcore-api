# Project Management
- Always update the README file when behavior or options change.
- When documenting configuration options, sort them alphabetically by option name.
- Maintain CHANGELOG.md with notable changes.
- Ensure 100% test coverage for changes (happy path, edge cases, and regressions).
- After any code changes, run tests and compile the example projects.

# Code Style
- Always annotate exported code with JSDoc comments.
- Add inline comments only for non-obvious or complex logic.
- Preserve existing public APIs unless the change explicitly requires an API update.

# Specifications / Description
- This project is a C# emitter for TypeSpec.
- TypeSpec: https://typespec.io
- TypeSpec repository: https://github.com/microsoft/typespec

# Emitter Conventions
- Default output directory for model and interface files is Models.
- Default output directories for other artifacts are Controllers, Services, and Helpers.
- namespace-from-path defaults to true.
- When namespace-from-path is true, generated namespaces must reflect output directory paths for all generated artifacts.
- Generated using directives must include referenced namespaces and any configured additional-usings.
- The emitter must support both explicit enums and inferred enums from string-literal unions.
- MergePatchUpdate models must preserve strong typing (for example, MergePatchValue<WidgetColor?>, not object fallbacks).

# Validation Checklist
- Run npm run build.
- Run npm test.
- Compile example/simple-api and example/versioned-api with npx tsp compile .
  
