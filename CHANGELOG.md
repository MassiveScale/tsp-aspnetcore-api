# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Patch validators now reference the correct C# type in `AbstractValidator<T>` and `IValidator<T>` registrations. Previously, the generated code used a non-existent `{Model}Patch` type; it now correctly uses the actual PATCH body type (e.g. `PetMergePatchUpdate` for MergePatch bodies).
- `ValidatorsInitializer.g.cs` now registers patch validators against the actual PATCH body type instead of the non-existent `{Model}Patch` type.

### Changed

- Validators now follow the same namespace logic as controllers and services. The namespace is derived from the output path when `namespace-from-path` is enabled, rather than from the TypeSpec model's namespace.
- Properties marked `@visibility(Lifecycle.Read)` (read-only) are excluded from generated POST and PATCH validators.

## [1.3.0] - 2026-05-15

### Added

- FluentValidation validator generation (`emit-validators: true`). When enabled, the emitter produces:
  - `{Model}Validator.g.cs` — `AbstractValidator<{Model}>` for POST request bodies.
  - `{Model}PatchValidator.g.cs` — patch-aware `AbstractValidator<{Model}Patch>` whose rules fire only when the corresponding property is present in the patch.
  - `ValidatorsInitializer.g.cs` — `AddGeneratedValidators(this IServiceCollection)` extension method for registering all validators with ASP.NET Core DI.
- Constraint decorators translated to FluentValidation rules: `@minLength`, `@maxLength`, `@pattern`, `@format("email")`, `@minValue`, `@maxValue`, enum membership, and `NotEmpty` for required non-optional string properties.
- Nested model validators are injected as constructor parameters and wired via `SetValidator` / `RuleForEach`+`SetValidator`.
- All generated validators are `partial` classes with a virtual `ExtendRules()` method for adding custom rules without touching generated code.
- Four version strategies for `@versioned` specs: `earliest`, `latest`, `per-version`, and `version-aware`. Auto-detected: `version-aware` when `@versioned` is present, `earliest` otherwise.
- Version-aware validators embed `ResolveApiVersion` and apply later-version rules conditionally via `When(() => IsAtLeast(...))` guards. They accept `IHttpContextAccessor` to read the version from the route, `api-version` header, or `api-version` query parameter.
- New options: `emit-validators`, `validators`, `validators-output-dir`, `validators-output-subdirectory`, `validators-version-strategy`.

## [1.2.0] - 2026-05-12

### Added

- Model properties with TypeSpec default values now emit C# property initializers. Supported value kinds: enum members (`Size.Medium`), string literals (`"production"`), numeric literals (`20`), and boolean literals (`true`/`false`).

### Changed

- Service interface methods that have no response body (e.g. `void`, `204 No Content`, or response unions containing only `@error` variants) now return a plain `Task` instead of `Task<object?>`.
- Service interface methods now use the `@body` type directly as the return type when a response has a complex shape (`@statusCode`, `@header`, `@body`); the status code and headers are not reflected at the service layer.
- `@error` models are excluded from service return types entirely — errors are surfaced as exceptions and must not be returned by service methods.
- Added `eq` Handlebars helper to the template environment, enabling `{{#if (eq returnType "void")}}` in custom service templates.

## [1.1.0] - 2026-05-10

### Fixed

- Corrected versioned controller route generation so each operation only emits routes for versions where that operation is available.
- Corrected versioned route templates to preserve operation path parameters (for example, `{id}` is now included in generated method routes when applicable).
- Fixed availability filtering for versioned routes when version enum names differ from their route values (for example, `v1_1` with value `"1.1"`).
- Updated generated `MergePatchUpdate<T>` model/interface properties to use `MergePatchValue<T?>` wrappers so JSON Merge Patch can distinguish absent fields from explicit `null` values.
- Service interface files now include `using` directives for all model namespaces referenced by operation parameters and return types.
- Controller files now include `using` directives for all model namespaces referenced by operation parameters and return types.
- When `namespace-from-path` is enabled, all generated files (models, interfaces, enums, controllers, services, and helpers) now correctly include their output directory in their C# namespace (e.g., `MyApp.Models`, `MyApp.Controllers`), and reference correct model namespaces with path-derived suffixes.
- Models and interfaces now respect the `namespace-from-path` option and include output directory names in their namespaces (e.g., models in `Models/` → `RootNamespace.Models`).

### Changed

- Updated route behavior documentation to describe method-level `[Http<Verb>("...")]` attributes per available operation version.
- Updated the versioned API example output to reflect version-aware route emission and path parameter preservation.
- Merge patch update properties now default to `MergePatchValue<T?>.Absent` in generated classes.
- `MergePatchValue` helper generation is now automatic when merge patch update models are emitted, even when `emit-helpers` is `false`.
- Added regression tests covering merge patch wrapper typing and helper emission.
- Added a `pretest` build step and a VS Code-friendly test shim (`test/aspnetcore.api.test.mjs`) to improve test discovery and execution in the VS Code Testing panel.
- Added workspace extension recommendations for VS Code test discovery and test UI integration (`hbenl.vscode-test-explorer`, `connor4312.nodejs-testing`).
- Default value for `models-output-dir` changed from `emitter-output-dir` to `"Models"`.
- Default value for `interfaces-output-dir` changed from `emitter-output-dir` to `"Models"`.
- Service interface and controller files now include any `additional-usings` specified in the emitter configuration.
- When `namespace-from-path` is true (the default), output directory paths are now always included in namespaces, even for default directories. This ensures consistent path-based namespace derivation across all generated file types.


### Added

- Added regression tests for:
  - versioned routes including path parameters,
  - operation-level version availability filtering,
  - version-name versus version-value availability mapping.
