/**
 * @module lib
 *
 * Defines the public emitter-options contract, the JSON Schema used by the
 * TypeSpec compiler to validate those options, and the shared diagnostic
 * library instance.
 */

import {
  createTypeSpecLibrary,
  JSONSchemaType,
  paramMessage,
} from "@typespec/compiler";

/**
 * Paths to custom Handlebars templates that replace the built-in defaults.
 * Only the templates listed here can be overridden; all keys are optional.
 */
export interface TemplateOverrides {
  /** Custom template for the file wrapper (namespace + usings). */
  file?: string;
  /** Custom template for C# class declarations. */
  class?: string;
  /** Custom template for C# interface declarations. */
  interface?: string;
  /** Custom template for C# enum declarations. */
  enum?: string;
  /** Custom template for ASP.NET Core abstract controller classes. */
  controller?: string;
  /** Custom template for service interface declarations. */
  "service-interface"?: string;
  /** Custom template for the generic MergePatch&lt;T&gt; helper class. */
  "merge-patch"?: string;
  /** Custom template for the per-entity typed merge patch class (used when merge-patch-style is "typed"). */
  "entity-merge-patch"?: string;
  /** Custom template for the EnumMemberConverter helper class. */
  "enum-member-converter"?: string;
  /** Custom template for the BooleanStringJsonConverter helper class (used for `@encode(string)` on booleans). */
  "bool-string-converter"?: string;
  /** Custom template for the standard POST validator class. */
  "validator-post"?: string;
  /** Custom template for the standard PATCH validator class. */
  "validator-patch"?: string;
  /** Custom template for the version-aware POST validator class. */
  "validator-post-version-aware"?: string;
  /** Custom template for the version-aware PATCH validator class. */
  "validator-patch-version-aware"?: string;
  /** Custom template for the `ValidatorsInitializer` DI registration class. */
  "validator-initializer"?: string;
}

/**
 * All configuration options accepted by the emitter in `tspconfig.yaml` under
 * the `options["@massivescale/tsp-aspnetcore-api"]` key.
 */
export interface EmitterOptions {
  /**
   * Root C# namespace. Every section namespace that is not set explicitly
   * defaults to this root plus the section name (e.g. `<root>.Models`). It is
   * also stripped from model folder paths, so a model in TypeSpec namespace
   * `RootNs.Sub` is placed under `Models/Sub/` rather than `Models/RootNs/Sub/`.
   * When not set, the root is inferred from the TypeSpec namespace tree.
   */
  "root-namespace"?: string;

  /**
   * Verbatim C# namespace for all generated model and enum files.
   * When not set, defaults to `<root-namespace>.Models`.
   */
  "models-namespace"?: string;

  /**
   * Verbatim C# namespace for all generated controller base class files.
   * When not set, defaults to `<root-namespace>.Controllers`.
   */
  "controllers-namespace"?: string;

  /**
   * Verbatim C# namespace for all generated service interface files.
   * When not set, defaults to `<root-namespace>.Services`.
   */
  "services-namespace"?: string;

  /**
   * Verbatim C# namespace for all generated validator files.
   * When not set, defaults to `<root-namespace>.Validators`.
   */
  "validators-namespace"?: string;

  /**
   * Verbatim C# namespace for all generated helper files.
   * When not set, defaults to `<root-namespace>.Helpers`.
   */
  "helpers-namespace"?: string;

  /**
   * Rewrites TypeSpec namespace names to different C# namespaces.
   * The longest matching key wins when multiple entries could apply.
   *
   * @example `{ "Legacy.Common": "Acme.Common" }`
   */
  "namespace-map"?: Record<string, string>;

  /**
   * File extension for all emitted C# files.
   * Defaults to `.g.cs` (the conventional suffix for generated code).
   */
  "file-extension"?: string;

  /**
   * Output directory for generated model classes and enums.
   * Relative paths are resolved against the emitter output dir.
   */
  "models-output-dir"?: string;

  /**
   * When `true`, a companion `I<Model>` interface file is emitted for every
   * model class. Defaults to `false`.
   */
  "emit-interfaces"?: boolean;

  /**
   * Output directory for generated model interfaces (`I<Model>`).
   * Relative paths are resolved against the emitter output dir.
   */
  "interfaces-output-dir"?: string;

  /**
   * When `false`, no controller base class files are emitted.
   * Defaults to `true`.
   */
  "emit-controllers"?: boolean;

  /**
   * Output directory for generated controller base classes.
   * Defaults to `Controllers/` inside the emitter output dir.
   */
  "controllers-output-dir"?: string;

  /**
   * When `false`, no service interface files are emitted.
   * Defaults to `true`.
   */
  "emit-services"?: boolean;

  /**
   * Output directory for generated service interfaces and abstract classes.
   * Defaults to `Services/` inside the emitter output dir.
   */
  "services-output-dir"?: string;

  /**
   * When `true`, the `EnumMemberConverter` helper is emitted. Defaults to
   * `false`. The other helpers do not depend on this setting: `MergePatch<T>`
   * is always emitted when `merge-patch-style` is `"generic"`, and
   * `BooleanStringJsonConverter` is emitted whenever a boolean property uses
   * `@encode(string)`.
   */
  "emit-helpers"?: boolean;

  /**
   * Output directory for generated helper classes (e.g. `MergePatch<T>`).
   * Defaults to `Helpers/` inside the emitter output dir.
   */
  "helpers-output-dir"?: string;

  /**
   * Route prefix prepended to every controller route attribute.
   * Defaults to `"api/{version}"`.
   *
   * The `{version}` token is replaced with the actual API version value when
   * the service is versioned (`@versioned`), and stripped (along with any
   * adjacent slashes) for unversioned services.
   *
   * @example `"api/{version}"` + version `v1.0` → `[HttpGet("/api/v1.0/widgets")]`
   * @example `"api/{version}"` (unversioned) → `[HttpGet("/api/widgets")]`
   */
  "route-prefix"?: string;

  /**
   * Controls where model, interface, and enum files are placed. It never
   * changes the C# namespace written into a file.
   *
   * - `false` (the default) — files go in subdirectories that mirror the
   *   TypeSpec namespace (after `namespace-map` rewrites) below the root
   *   namespace, e.g. `Models/Users/User.g.cs` for `MyApp.Users.User`.
   * - `true` — files go directly in their output directory, e.g.
   *   `Models/User.g.cs`.
   */
  "namespace-from-path"?: boolean;

  /**
   * Extra `using` directives added to every emitted file: models, enums,
   * interfaces, controllers, services, helpers, and validators.
   * @example `["System.Text.Json.Serialization"]`
   */
  "additional-usings"?: string[];

  /**
   * When `true`, generated references to models, enums, and helpers include
   * their namespace. When `false` (the default), short names are emitted and
   * the required namespaces are added as `using` directives.
   */
  "fully-qualified-types"?: boolean;

  /**
   * When `true` (the default), every property is emitted as a nullable type
   * regardless of whether it is marked optional in TypeSpec.
   * Set to `false` to emit non-optional properties as non-nullable.
   */
  "nullable-properties"?: boolean;

  /**
   * Suffix appended to generated abstract class names.
   * Defaults to `"Base"`, producing e.g. `UsersControllerBase`.
   */
  "abstract-suffix"?: string;

  /**
   * When `true`, a `CancellationToken cancellationToken` parameter is
   * added to every generated controller action and service method, and
   * `using System.Threading;` is emitted in controller and service files.
   * Defaults to `true`.
   */
  "cancellation-token"?: boolean;

  /**
   * When `true` (the default), previously-generated files are removed from the
   * output directories before emitting, so renamed or deleted TypeSpec types do
   * not leave stale `.g.cs` files behind.
   *
   * Only files that (a) match `file-extension` and (b) carry the
   * `<auto-generated>` marker written by the default `file` template are
   * deleted. Extension-matching files without the marker are left in place and
   * reported with a warning — hand-written code is never removed.
   */
  "clean-output-dirs"?: boolean;

  /** Custom Handlebars template paths keyed by template name. */
  templates?: TemplateOverrides;

  // ── FluentValidation options ─────────────────────────────────────────────

  /**
   * When `true`, FluentValidation validator classes are generated for models
   * that appear as POST or PATCH request bodies.
   * Defaults to `false`.
   */
  "emit-validators"?: boolean;

  /**
   * Output directory for generated validator classes.
   * Relative paths are resolved against the emitter output dir.
   * Defaults to `Validators/`.
   */
  "validators-output-dir"?: string;

  /**
   * Controls which validator type(s) are emitted for each model.
   * - `"post"` — emits `{Model}Validator.g.cs` with standard FluentValidation rules.
   * - `"patch"` — emits `{Model}PatchValidator.g.cs` with conditional patch-aware rules.
   * - `"both"` — emits both files (default).
   */
  validators?: "post" | "patch" | "both";

  /**
   * Controls how `MergePatch` support is emitted for PATCH operations.
   * - `"generic"` (default) — emits a single shared `MergePatch<T>` helper class in the helpers directory.
   * - `"typed"` — emits a per-entity `{Model}MergePatchUpdate` class in the models directory, avoiding a
   *   generic helper. Both styles expose the same API surface.
   */
  "merge-patch-style"?: "generic" | "typed";

  /**
   * Controls how versioning affects validator generation when the TypeSpec spec
   * uses `@versioned`.
   * - `"earliest"` — emits validators based on the earliest version only.
   * - `"latest"` — emits validators based on the latest version (emits a warning).
   * - `"per-version"` — emits separate validators for each version in its own subdirectory.
   * - `"version-aware"` — emits a single validator per model whose rules are applied
   *   conditionally based on the API version resolved from the live HTTP request.
   *
   * When unset, auto-detected: `"version-aware"` if `@versioned` is present, `"earliest"` otherwise.
   */
  "validators-version-strategy"?:
    "earliest" | "latest" | "per-version" | "version-aware";
}

/** JSON Schema used by the TypeSpec compiler to validate emitter options. */
const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "root-namespace": {
      type: "string",
      nullable: true,
      description:
        "Root C# namespace. Section namespaces default to this root plus the section name, and it is stripped from model folder paths. Inferred from the TypeSpec namespaces when not set.",
    },
    "namespace-map": {
      type: "object",
      nullable: true,
      required: [],
      additionalProperties: { type: "string" },
      description:
        "Rewrites TypeSpec namespace names before they are used for file placement. The longest matching key wins.",
    },
    "file-extension": {
      type: "string",
      nullable: true,
      description: 'File extension for all emitted files. Defaults to ".g.cs".',
    },
    "models-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for model classes and enums, relative to emitter-output-dir. Defaults to "Models".',
    },
    "emit-interfaces": {
      type: "boolean",
      nullable: true,
      description:
        "When true, emits an I<Model> interface for every model class. Defaults to false.",
    },
    "interfaces-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for model interfaces, relative to emitter-output-dir. Defaults to "Models".',
    },
    "emit-controllers": {
      type: "boolean",
      nullable: true,
      description:
        "When false, no controller base classes are emitted. Defaults to true.",
    },
    "controllers-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for controller base classes, relative to emitter-output-dir. Defaults to "Controllers".',
    },
    "emit-services": {
      type: "boolean",
      nullable: true,
      description:
        "When false, no service interfaces are emitted. Defaults to true.",
    },
    "services-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for service interfaces, relative to emitter-output-dir. Defaults to "Services".',
    },
    "emit-helpers": {
      type: "boolean",
      nullable: true,
      description:
        "When true, emits the EnumMemberConverter helper. MergePatch<T> and BooleanStringJsonConverter are emitted whenever they are needed. Defaults to false.",
    },
    "helpers-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for helper classes, relative to emitter-output-dir. Defaults to "Helpers".',
    },
    "route-prefix": {
      type: "string",
      nullable: true,
      description:
        'Prefix prepended to every controller action route. "{version}" is replaced with the API version, or removed for unversioned services. Defaults to "api/{version}".',
    },
    "namespace-from-path": {
      type: "boolean",
      nullable: true,
      description:
        "When true, model, interface, and enum files are written flat into their output directory instead of TypeSpec-namespace subdirectories. Never changes C# namespaces. Defaults to false.",
    },
    "additional-usings": {
      type: "array",
      nullable: true,
      items: { type: "string" },
      description: "Extra using directives added to every emitted file.",
    },
    "fully-qualified-types": {
      type: "boolean",
      nullable: true,
      description:
        "When true, references to generated models, enums, and helpers include their namespace instead of relying on using directives. Defaults to false.",
    },
    "nullable-properties": {
      type: "boolean",
      nullable: true,
      description:
        "When true, every property is emitted as a nullable type. When false, only optional and `| null` properties are nullable. Defaults to true.",
    },
    "abstract-suffix": {
      type: "string",
      nullable: true,
      description:
        'Suffix appended to generated abstract class names. Defaults to "Base".',
    },
    "cancellation-token": {
      type: "boolean",
      nullable: true,
      description:
        "When true, adds a CancellationToken parameter to every controller action and service method. Defaults to true.",
    },
    "clean-output-dirs": {
      type: "boolean",
      nullable: true,
      description:
        "When true, removes previously generated files (matching file-extension and carrying the <auto-generated> marker) before emitting. Defaults to true.",
    },
    templates: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description:
        "Custom Handlebars template paths keyed by template name, relative to the current working directory.",
      properties: {
        file: { type: "string", nullable: true },
        class: { type: "string", nullable: true },
        interface: { type: "string", nullable: true },
        enum: { type: "string", nullable: true },
        controller: { type: "string", nullable: true },
        "service-interface": { type: "string", nullable: true },
        "merge-patch": { type: "string", nullable: true },
        "entity-merge-patch": { type: "string", nullable: true },
        "enum-member-converter": { type: "string", nullable: true },
        "bool-string-converter": { type: "string", nullable: true },
        "validator-post": { type: "string", nullable: true },
        "validator-patch": { type: "string", nullable: true },
        "validator-post-version-aware": { type: "string", nullable: true },
        "validator-patch-version-aware": { type: "string", nullable: true },
        "validator-initializer": { type: "string", nullable: true },
      },
    },
    "models-namespace": {
      type: "string",
      nullable: true,
      description:
        "Verbatim C# namespace for models, interfaces, and enums. Defaults to <root-namespace>.Models.",
    },
    "controllers-namespace": {
      type: "string",
      nullable: true,
      description:
        "Verbatim C# namespace for controller base classes. Defaults to <root-namespace>.Controllers.",
    },
    "services-namespace": {
      type: "string",
      nullable: true,
      description:
        "Verbatim C# namespace for service interfaces. Defaults to <root-namespace>.Services.",
    },
    "validators-namespace": {
      type: "string",
      nullable: true,
      description:
        "Verbatim C# namespace for validators. Defaults to <root-namespace>.Validators.",
    },
    "helpers-namespace": {
      type: "string",
      nullable: true,
      description:
        "Verbatim C# namespace for helper classes. Defaults to <root-namespace>.Helpers.",
    },
    "emit-validators": {
      type: "boolean",
      nullable: true,
      description:
        "When true, emits FluentValidation validators for models used as POST or PATCH request bodies. Defaults to false.",
    },
    "validators-output-dir": {
      type: "string",
      nullable: true,
      description:
        'Output directory for validators, relative to emitter-output-dir. Defaults to "Validators".',
    },
    validators: {
      type: "string",
      enum: ["post", "patch", "both"],
      nullable: true,
      description:
        'Which validators to emit per model: "post", "patch", or "both". Defaults to "both".',
    },
    "validators-version-strategy": {
      type: "string",
      enum: ["earliest", "latest", "per-version", "version-aware"],
      nullable: true,
      description:
        'How API versions affect validators. Defaults to "version-aware" when the service uses @versioned, otherwise "earliest".',
    },
    "merge-patch-style": {
      type: "string",
      enum: ["generic", "typed"],
      nullable: true,
      description:
        'How MergePatch support is emitted: "generic" (one shared MergePatch<T> helper) or "typed" (one {Model}MergePatchUpdate class per entity). Defaults to "generic".',
    },
  },
  required: [],
};

/**
 * Shared TypeSpec library instance.  Registers the emitter's diagnostic codes
 * and option schema with the compiler toolchain.
 */
export const $lib = createTypeSpecLibrary({
  name: "@massivescale/tsp-aspnetcore-api",
  diagnostics: {
    "template-load-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to load custom template "${"name"}" from "${"path"}": ${"reason"}`,
      },
    },
    "version-strategy-breaking": {
      severity: "warning",
      messages: {
        default: paramMessage`Using validators-version-strategy "latest" may produce validators that reject requests from clients targeting earlier API versions. Consider "earliest" or "version-aware" to avoid breaking changes.`,
      },
    },
    "invalid-server-name": {
      severity: "error",
      messages: {
        default: paramMessage`@serverName value "${"name"}" is not a valid C# identifier. Use only letters, digits, and underscores, starting with a letter or underscore (optionally prefixed with @). Reserved keywords must be prefixed with @ (e.g. "@class").`,
      },
    },
    "duplicate-model-name": {
      severity: "error",
      messages: {
        default: paramMessage`"${"model"}" maps to the C# class "${"className"}", which is already emitted for "${"existing"}". Rename one of them with @friendlyName or @serverName.`,
      },
    },
    "discriminator-variant-skipped": {
      severity: "warning",
      messages: {
        default: paramMessage`"${"variant"}" is a response or metadata-only model, so it gets no class and is omitted from the polymorphic types of "${"base"}". A payload with ${"property"} "${"value"}" will not deserialize.`,
      },
    },
    "merge-patch-recursive-reference": {
      severity: "error",
      messages: {
        default: paramMessage`"${"property"}" makes nested MergePatch validation recursive (${"cycle"}), which is not supported: the generated PATCH validators would depend on each other and could not be resolved from dependency injection. Break the loop, for example by excluding the property from updates with @visibility, or emit only POST validators with validators: "post".`,
      },
    },
    "output-file-left-behind": {
      severity: "warning",
      messages: {
        default: paramMessage`Left "${"path"}" in place during output-directory cleanup: it matches the generated file extension but has no <auto-generated> marker, so it is not treated as emitter output. Delete it manually if it is stale.`,
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;
