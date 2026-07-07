# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.12.0] - 2026-07-07

### Changed

- Base models carrying `@discriminator` are now emitted as `abstract` classes. The base type never has a valid discriminator value of its own — only its derived types do — so it should never be instantiated directly; derived classes are unaffected and remain concrete. This is transparent to polymorphic JSON (de)serialization and FluentValidation's `SetInheritanceValidator` dispatch, since neither needs to construct the base type directly. See [Model Generation](docs/models.md#discriminator). **Potentially breaking**: any hand-written code that directly instantiates a `@discriminator` base model (e.g. `new Pet()`) will no longer compile.

## [0.11.3] - 2026-07-06

### Added

- Models carrying TypeSpec's built-in `@discriminator` decorator now emit `[JsonPolymorphic(TypeDiscriminatorPropertyName = "...")]` and one `[JsonDerivedType(typeof(...), "...")]` per resolvable derived type, enabling native System.Text.Json polymorphic (de)serialization. The discriminator property itself is omitted from the generated class/interface on every model in the hierarchy — System.Text.Json rejects a declared property whose JSON name collides with the type discriminator. See [Model Generation](docs/models.md#discriminator).
- POST validators for discriminated base models now emit `SetInheritanceValidator` to dispatch validation to derived-type validators at runtime. Previously, child-class properties were never validated because the controller payload is typed as the base class and FluentValidation only resolved the base validator. See [Validators — Polymorphic dispatch](docs/validators.md#polymorphic-dispatch).

### Fixed

- All emitted code now references other emitted types (models, enums, interfaces, and `MergePatch<T>`) by fully-qualified name instead of a short name paired with a computed `using` directive. This applies uniformly — including base classes, property types, companion-interface implementations, discriminator `[JsonDerivedType(typeof(...))]` attributes, enum default-value initializers, and controller/service/validator signatures — even when the reference is within the same namespace. Closes a class of "type or namespace not found" / ambiguous-reference compile errors that could occur when `models-namespace`, `controllers-namespace`, `services-namespace`, `validators-namespace`, or `helpers-namespace` differ, most notably a genuine bug where PATCH validators emitted `TryGetValue<{EnumType}?>(...)` for an enum property without qualifying `{EnumType}` or adding a `using` for the models namespace. See [Cross-namespace references](docs/models.md#cross-namespace-references).
- Validator generation now skips discriminator properties for `@discriminator` hierarchies. Previously those properties were emitted as normal rules, which could generate uncompilable validator code and incorrectly fail validation for required discriminator wire values.

## [0.11.2] - 2026-07-04

### Fixed

- `@serverName` on a model was not respected in the PATCH body type name derived for validators when the PATCH body is the plain entity type (not a `MergePatchUpdate<T>`). The raw, un-renamed TypeSpec model name was used instead, affecting descendants as well as the source model.

## [0.11.1] - 2026-06-24

### Fixed

- Validator template XML summary `<see cref="..."/>` references now use fully-qualified generated type names (`qualifiedModelName` / `qualifiedPatchBodyTypeName`) instead of short model names. This prevents invalid or ambiguous cref targets in generated C# documentation comments when namespaces differ.

## [0.11.0] - 2026-06-13

### Changed

- Service interfaces are now emitted as `public partial interface` to enable extension and composition patterns. This allows consuming applications to add custom methods and behavior to generated service interfaces without modifying generated code.

## [0.10.0] - 2026-06-09

### Added

- `merge-patch-style` option (`"generic"` | `"typed"`, default `"generic"`). When set to `"typed"`, the emitter generates a concrete `{Model}MergePatch` class per entity (e.g. `WidgetMergePatch`) in the models output directory instead of a single shared `MergePatch<T>` generic helper in the helpers directory. Both styles expose the same full API surface. Controller and service signatures, patch validator `AbstractValidator<T>` declarations, and `ValidatorsInitializer` DI registrations all update automatically based on the selected style.
- `entity-merge-patch` template key: a custom Handlebars template that replaces the built-in per-entity typed merge patch class when `merge-patch-style: "typed"`. Template variables: `modelName` (short C# class name) and `qualifiedModelName` (fully-qualified C# type).
- `MergePatch<T>.Patch(T original)` — applies all explicitly defined patch properties to an existing entity instance via reflection. Each property is deserialized to the declared property type on `T` and written back; properties absent from `T`, read-only, or that cannot be deserialized are silently skipped. Replaces the previous approach of generating per-model patch methods from TypeSpec property types.
- `MergePatch<T>.PatchAsync(T original, …, CancellationToken)` — asynchronous variant of `Patch`. Applies the patch synchronously and returns `ValueTask.CompletedTask`. Throws `OperationCanceledException` if the cancellation token is already cancelled before work begins. Returns a `ValueTask` (zero allocation on the hot path) for seamless composition in async controller actions.
- `MergePatch<T>.FromJson(string json, JsonSerializerOptions?)` — static factory that deserializes a raw JSON string into a `MergePatch<T>`, treating every property present in the JSON as explicitly defined in the patch.
- `MergePatch<T>.From(T entity, JsonSerializerOptions?)` — static factory that builds a `MergePatch<T>` from an existing entity instance by serializing it to JSON. Useful for seeding test scenarios or applying full-object replacements. Respects `JsonSerializerOptions.DefaultIgnoreCondition`.
- `MergePatch<T>.TryGetPropertyValue(string name, out object? value, JsonSerializerOptions?)` — attempts to get and deserialize the patch value for a named property to its declared type on `T` via reflection.
- `MergePatch<T>.TrySetPropertyValue(string name, object? value, JsonSerializerOptions?)` — serializes a value and stores it as a patch entry for the named property. Pass `null` to mark the field for clearing (RFC 7396 clear-field semantics).
- `MergePatch<T>.TryGetPropertyType(string name, out Type? type)` — returns the declared `System.Type` of the named property on `T` via reflection.
- `MergePatch<T>.GetChangedPropertyNames()` — returns the names of all properties explicitly included in the patch payload (equivalent to `DefinedProperties` but as a method for use in LINQ chains).
- `MergePatch<T>` now caches the public instance properties of `T` in a static field (`_typeProperties`) so reflection is only performed once per concrete type at class initialization.

### Fixed

- `ValidatorsInitializer.g.cs` emitted `IValidator<MergePatch<{Model}>>` without qualifying the `MergePatch<T>` type with its helpers namespace, causing C# compilation errors when the validators namespace differs from the helpers namespace. Registration entries now use the fully-qualified form (e.g. `Demo.Helpers.MergePatch<Demo.Models.Widget>`).
- `decimal.TryParse` in patch validator templates (`validator-patch.hbs`, `validator-patch-version-aware.hbs`) used the ambient culture by default. JSON numeric text is always culture-invariant; parsing now explicitly passes `System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture` to all `decimal.TryParse` calls, preventing invalid rejections in non-invariant server cultures.

### Changed

- `MergePatch<T>` no longer uses `MergePatchValue<T>` wrapper properties. The class now uses `[JsonExtensionData]` on a `Dictionary<string, JsonElement>` to capture all incoming JSON properties as raw `JsonElement` values. This eliminates per-property code generation and removes the `MergePatchValue<T>` dependency entirely. The `IsDefined` / `IsNull` / `GetString` / `TryGetValue` API is unchanged.

## [0.8.0] - 2026-06-06

### Changed

- `@serverName` is no longer supported on `enum` types or `enum` members. Applying it to a TypeSpec `enum` or enum member now produces a compile-time error. Use `@serverName` on `model` or `model property` targets only. Enum files and enum member identifiers continue to use the PascalCased TypeSpec names.
- `@serverName` values are now validated at compile time. A name must be a valid C# identifier (letters, digits, and underscores, starting with a letter or underscore, optionally prefixed with `@`). Names containing path separators, spaces, or other punctuation are rejected with the `invalid-server-name` diagnostic. This prevents both invalid C# output and path-traversal attacks via the output filename. Bare C# reserved keywords (e.g. `class`, `string`) are now also rejected; prefix with `@` to form a verbatim identifier (e.g. `@class`).
- `@serverName` applied to a `model` now propagates to all references to that model: base class declarations and property type references in other generated files use the server name. Previously only the class/interface declaration and filename were renamed; all references still used the raw TypeSpec name, producing uncompilable C# output.
- Controller and service type resolution now honors model `@serverName` overrides. Request/response body parameter types and return types in generated controller/service signatures now match the renamed model identifier.
- Interface filename generation is now consistent with interface type naming for verbatim identifiers. For a model renamed to `@name`, interface output is emitted as `Iname.g.cs` to match `interface Iname`.
- Validator dependency injection constructor parameters and `referencedValidators` entries now derive their names from `@serverName` when the referenced model has one. Previously the raw TypeSpec model name was used, causing validators to reference non-existent C# identifiers when the model was renamed.
- `MergePatchUpdate<T>` models are no longer emitted as individual C# classes. The emitter replaces any PATCH body whose TypeSpec type is (or extends) `MergePatchUpdate<T>` with the generic `MergePatch<T>` helper in controller and validator signatures. This eliminates per-model boilerplate and reduces generated output size. The `MergePatch<T>` helper is emitted once per project into the helpers directory and exposes `IsDefined`, `IsNull`, `GetString`, `TryGetValue`, and `DefinedProperties` for RFC 7396-conformant patch handling.
- Validators now always use fully-qualified C# type names in `AbstractValidator<T>`, constructor parameter types, and `ValidatorsInitializer` registrations. Previously the short model name was used, which produced uncompilable output when the validator namespace differed from the model namespace.
- `namespace-from-path: false` is now correctly respected in validator files. Previously, validators always included the output directory suffix in their namespace even when `namespace-from-path` was disabled.
- `emit-interfaces` now defaults to `false`. Interfaces are no longer generated unless `emit-interfaces: true` is set in `tspconfig.yaml`.
- `namespace-from-path` now defaults to `false`. Output-directory segments are no longer automatically appended to C# namespaces. Set `namespace-from-path: true` to restore the previous behaviour.

### Changed (continued)

- Per-section namespace options renamed and redesigned. The old `*-root-namespace` options (`controllers-root-namespace`, `services-root-namespace`, `validators-root-namespace`, `models-root-namespace`, `interfaces-root-namespace`) are removed. Replacements are `controllers-namespace`, `services-namespace`, `validators-namespace`, `models-namespace`, and `helpers-namespace` (new). Each option now sets the C# namespace **verbatim** for its section — no output-directory suffix is appended. When unset, each section defaults to `<root-namespace>.<Section>` (e.g. `App.Models`, `App.Controllers`). Interfaces always share the models namespace and no longer have a dedicated option.
- `namespace-from-path` now controls **file placement only**. It no longer affects C# namespace strings in any generated file. When `true`, all files are placed flat inside their output directory. When `false` (the default), files are placed in subdirectories derived from the TypeSpec namespace with the root namespace prefix stripped.
- `namespace-map` now affects **file placement** (folder path computation) only. It no longer changes the C# namespace written into generated files. The mapped TypeSpec namespace is used to compute the output subdirectory when `namespace-from-path` is `false`.
- `When(() => IsAtLeast(...))` in version-aware validator templates corrected to `When(_ => IsAtLeast(...))` so the lambda signature matches FluentValidation's `Func<T, bool>` overload.

### Fixed

- `RuleFor(x => x.{Prop}).Null()` is no longer emitted for non-nullable value-type properties (e.g. `bool`, `int`, `Guid`, `DateTimeOffset`) on POST validators. FluentValidation's `.Null()` rule always fails for non-nullable value types; the emitter now skips the rule for such properties. The constraint is still emitted for reference-type and nullable properties.

## [0.7.0] - 2026-06-06

### Added

- `@serverName` decorator: overrides the C# identifier for models and model properties. For models it also changes the generated file name **and** updates all generated references to that model (including property types, base classes, and controller/service signatures). `JsonPropertyName` attribute values are unchanged.
- `Patch(TEntity target)` method on generated MergePatch classes. Applies all present fields from the patch to an existing entity instance in-place — only properties that were explicitly set in the JSON Merge Patch payload (`IsPresent == true`) are copied; absent properties leave the target unchanged. Mirrors the `Delta<T>.Patch()` pattern from `Microsoft.AspNetCore.OData`. Properties whose `MergePatchValue<T>` inner type differs from the corresponding entity property type (e.g. nested-model array properties that use a `ReplaceOnly` variant) are excluded from the generated assignments; a comment identifies each skipped property and its type mismatch so developers know what to handle manually.

## [0.6.0] - 2026-05-30

### Added

- `route-prefix` option: an optional string prefix prepended to every generated controller route. Supports `{version}` tokens — when the spec is versioned and `route-prefix` contains `{version}`, the token is replaced with each version's route value (e.g. `api/{version}` → `[Route("api/v1/pets")]`). Repeated slashes produced by prefix/path concatenation are normalized automatically.

## [0.5.0] - 2026-05-28

### Added

- `cancellation-token` option (default `true`): adds `CancellationToken cancellationToken` to every generated controller action and service method, and emits `using System.Threading;` in controller and service files. Set `cancellation-token: false` in `tspconfig.yaml` to opt out.

## [0.4.0] - 2026-05-15

### Fixed

- Patch validators now reference the correct C# type in `AbstractValidator<T>` and `IValidator<T>` registrations. Previously, the generated code used a non-existent `{Model}Patch` type; it now correctly uses the actual PATCH body type (e.g. `PetMergePatchUpdate` for MergePatch bodies).
- `ValidatorsInitializer.g.cs` now registers patch validators against the actual PATCH body type instead of the non-existent `{Model}Patch` type.
- Corrected `emit-helpers` JSDoc — the option defaults to `false`, not `true` as previously documented.
- All five validator templates now correctly identify the generating package as `@massivescale/tsp-aspnetcore-api` in their `<auto-generated/>` header; previously all said `@massivescale/tsp-fluent-validators`.
- Version-aware validator templates (`validator-post-version-aware.hbs`, `validator-patch-version-aware.hbs`) now include `#pragma warning disable/restore` blocks for CS1591, CS0612, and CS0618, matching the non-version-aware templates and suppressing spurious compiler warnings on generated code.

### Changed

- `EnumMemberConverterFactory` and `EnumMemberConverter<T>` are now `public sealed` instead of `internal sealed`. This allows consumers to reference these types from separate assemblies (e.g. test projects, shared helper libraries). Use the `enum-member-converter` template override to revert to `internal` for single-assembly projects.

### Added

- Five new per-section root namespace options — `models-root-namespace`, `interfaces-root-namespace`, `controllers-root-namespace`, `services-root-namespace`, and `validators-root-namespace` — each override `root-namespace` for that output section only. When unset they fall back to the global `root-namespace` / inferred root, preserving all existing defaults.

### Changed

- Validators now follow the same namespace logic as controllers and services. The namespace is derived from the output path when `namespace-from-path` is enabled, rather than from the TypeSpec model's namespace.
- Properties marked `@visibility(Lifecycle.Read)` (read-only) are excluded from generated POST and PATCH validators.

### Removed

- `validators-output-subdirectory` option removed. Validator files are always written flat in `validators-output-dir` (or a version subdirectory when `validators-version-strategy` is `"per-version"`). The option previously defaulted to `false`, so existing projects are unaffected.

### Internal

- Extracted `SCALAR_MAP`, `FORMAT_MAP`, `pascalCase`, and `camelCase` into a new `src/utils.ts` module, eliminating duplication between `emitter.ts` and `controllers.ts`. Type-mapping changes now only need to be made in one place.
- Added `SERVICE_USINGS` constant, consistent with `SYSTEM_USINGS`, `CONTROLLER_USINGS`, and other `*_USINGS` constants.
- Updated `renderer.ts` to use the `node:` module-protocol prefix on built-in imports, matching the style already used in `emitter.ts`.

## [0.3.0] - 2026-05-15

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

## [0.2.0] - 2026-05-12

### Added

- Model properties with TypeSpec default values now emit C# property initializers. Supported value kinds: enum members (`Size.Medium`), string literals (`"production"`), numeric literals (`20`), and boolean literals (`true`/`false`).

### Changed

- Service interface methods that have no response body (e.g. `void`, `204 No Content`, or response unions containing only `@error` variants) now return a plain `Task` instead of `Task<object?>`.
- Service interface methods now use the `@body` type directly as the return type when a response has a complex shape (`@statusCode`, `@header`, `@body`); the status code and headers are not reflected at the service layer.
- `@error` models are excluded from service return types entirely — errors are surfaced as exceptions and must not be returned by service methods.
- Added `eq` Handlebars helper to the template environment, enabling `{{#if (eq returnType "void")}}` in custom service templates.

## [0.1.0] - 2026-05-10

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
