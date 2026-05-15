/**
 * @module lib
 *
 * Defines the public emitter-options contract, the JSON Schema used by the
 * TypeSpec compiler to validate those options, and the shared diagnostic
 * library instance.
 */

import { createTypeSpecLibrary, JSONSchemaType, paramMessage } from "@typespec/compiler";

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
  /** Custom template for the MergePatchValue helper class. */
  "merge-patch-value"?: string;
  /** Custom template for the EnumMemberConverter helper class. */
  "enum-member-converter"?: string;
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
   * Root C# namespace.  When set, this prefix is stripped from generated
   * folder paths so that `RootNs.Sub.Model` is placed under `Sub/Model.g.cs`
   * rather than `RootNs/Sub/Model.g.cs`.
   */
  "root-namespace"?: string;

  /**
   * Root C# namespace for generated model and enum files.
   * Overrides `root-namespace` for this section only.
   * Used as the fallback namespace for unnamespaced types and as the prefix
   * stripped from folder paths when `namespace-from-path` is `false`.
   */
  "models-root-namespace"?: string;

  /**
   * Root C# namespace for generated interface files.
   * Overrides `root-namespace` for this section only.
   */
  "interfaces-root-namespace"?: string;

  /**
   * Root C# namespace for generated controller base class files.
   * Overrides `root-namespace` for this section only.
   * The full controller namespace is: `<controllers-root-namespace>.<controllers-output-dir>`.
   */
  "controllers-root-namespace"?: string;

  /**
   * Root C# namespace for generated service interface files.
   * Overrides `root-namespace` for this section only.
   * The full service namespace is: `<services-root-namespace>.<services-output-dir>`.
   */
  "services-root-namespace"?: string;

  /**
   * Root C# namespace for generated validator files.
   * Overrides `root-namespace` for this section only.
   * The full validator namespace is: `<validators-root-namespace>.<validators-output-dir>`.
   */
  "validators-root-namespace"?: string;

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
   * When `false`, no `I<Model>` interface files are emitted.
   * Defaults to `true`.
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
   * When `true`, helper files (`MergePatchValue`, `EnumMemberConverter`) are emitted.
   * Defaults to `false`. Note: `MergePatchValue` is always emitted automatically
   * when any `MergePatchUpdate<T>` model is generated, regardless of this setting.
   */
  "emit-helpers"?: boolean;

  /**
   * Output directory for generated helper classes (e.g. `MergePatchValue`).
   * Defaults to `Helpers/` inside the emitter output dir.
   */
  "helpers-output-dir"?: string;

  /**
   * Route prefix prepended to every controller route attribute.
   * Defaults to `"api"`.
   * @example `"api/v2"` → `[HttpGet("/api/v2/widgets")]`
   */
  "route-prefix"?: string;

  /**
   * When `true` (the default), the C# namespace for controllers, services,
   * and helpers is derived from their output folder path rather than from
   * the TypeSpec namespace.
   *
   * When enabled (the default), all generated files — models, interfaces,
   * enums, controllers, services, and helpers — derive their C# namespace
   * from the `root-namespace` option combined with their output directory
   * path.  For example, with `root-namespace: "MyApp"`:
   *
   * - `controllers-output-dir: "Controllers"` → `namespace MyApp.Controllers`
   * - `models-output-dir: "Models"` → `namespace MyApp.Models`
   * - `helpers-output-dir: "Helpers"` → `namespace MyApp.Helpers`
   *
   * When disabled (`false`), models, interfaces, and enums use the TypeSpec
   * namespace, and controllers/services use the TypeSpec namespace of their
   * operation container.
   */
  "namespace-from-path"?: boolean;

  /**
   * Extra `using` directives appended to every emitted file.
   * @example `["System.Text.Json.Serialization"]`
   */
  "additional-usings"?: string[];

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
  "validators"?: "post" | "patch" | "both";

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
  "validators-version-strategy"?: "earliest" | "latest" | "per-version" | "version-aware";

}

/** JSON Schema used by the TypeSpec compiler to validate emitter options. */
const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "root-namespace": { type: "string", nullable: true },
    "namespace-map": {
      type: "object",
      nullable: true,
      required: [],
      additionalProperties: { type: "string" },
    },
    "file-extension": { type: "string", nullable: true },
    "models-output-dir": { type: "string", nullable: true },
    "emit-interfaces": { type: "boolean", nullable: true },
    "interfaces-output-dir": { type: "string", nullable: true },
    "emit-controllers": { type: "boolean", nullable: true },
    "controllers-output-dir": { type: "string", nullable: true },
    "emit-services": { type: "boolean", nullable: true },
    "services-output-dir": { type: "string", nullable: true },
    "emit-helpers": { type: "boolean", nullable: true },
    "helpers-output-dir": { type: "string", nullable: true },
    "route-prefix": { type: "string", nullable: true },
    "namespace-from-path": { type: "boolean", nullable: true },
    "additional-usings": {
      type: "array",
      nullable: true,
      items: { type: "string" },
    },
    "nullable-properties": { type: "boolean", nullable: true },
    "abstract-suffix": { type: "string", nullable: true },
    templates: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      properties: {
        file: { type: "string", nullable: true },
        class: { type: "string", nullable: true },
        interface: { type: "string", nullable: true },
        enum: { type: "string", nullable: true },
        controller: { type: "string", nullable: true },
        "service-interface": { type: "string", nullable: true },
        "merge-patch-value": { type: "string", nullable: true },
        "enum-member-converter": { type: "string", nullable: true },
        "validator-post": { type: "string", nullable: true },
        "validator-patch": { type: "string", nullable: true },
        "validator-post-version-aware": { type: "string", nullable: true },
        "validator-patch-version-aware": { type: "string", nullable: true },
        "validator-initializer": { type: "string", nullable: true },
      },
    },
    "models-root-namespace": { type: "string", nullable: true },
    "interfaces-root-namespace": { type: "string", nullable: true },
    "controllers-root-namespace": { type: "string", nullable: true },
    "services-root-namespace": { type: "string", nullable: true },
    "validators-root-namespace": { type: "string", nullable: true },
    "emit-validators": { type: "boolean", nullable: true },
    "validators-output-dir": { type: "string", nullable: true },
    validators: {
      type: "string",
      enum: ["post", "patch", "both"],
      nullable: true,
    },
    "validators-version-strategy": {
      type: "string",
      enum: ["earliest", "latest", "per-version", "version-aware"],
      nullable: true,
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
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;
