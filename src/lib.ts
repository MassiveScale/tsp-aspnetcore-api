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
   * When `false`, no helper files (`MergePatchValue`, `EnumMemberConverter`) are emitted.
   * Defaults to `true`.
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
      },
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
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;
