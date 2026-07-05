/**
 * @module emitter
 *
 * Core TypeSpec emitter.  The exported {@link $onEmit} function is called by
 * the TypeSpec compiler for every `emit` run and is responsible for:
 *
 * 1. Resolving all user-supplied options.
 * 2. Collecting models, enums, and HTTP service operations from the compiled
 *    program.
 * 3. Rendering each artifact through Handlebars templates.
 * 4. Writing the resulting `.g.cs` (or custom-extension) files to disk via the
 *    TypeSpec `emitFile` API.
 */

import {
  EmitContext,
  Enum,
  type EnumMember,
  Model,
  ModelProperty,
  Namespace,
  Program,
  type Scalar,
  Type,
  type Union,
  Value,
  emitFile,
  getDoc,
  getFormat,
  getLifecycleVisibilityEnum,
  getMaxLength,
  getMaxValue,
  getMinLength,
  getMinValue,
  getNamespaceFullName,
  getPattern,
  isArrayModelType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  isTemplateInstance,
  isVisible,
  navigateProgram,
  NoTarget,
  resolvePath,
} from "@typespec/compiler";
import { getAllHttpServices, type HttpOperationBody } from "@typespec/http";
import {
  getMergePatchSource,
  isMergePatch,
} from "@typespec/http/experimental/merge-patch";
import {
  getAllVersions,
  getAvailabilityMap,
  Availability,
} from "@typespec/versioning";
import type { Version } from "@typespec/versioning";
import Handlebars from "handlebars";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getServerName } from "./decorators.js";
import { EmitterOptions, reportDiagnostic } from "./lib.js";
import { SCALAR_MAP, FORMAT_MAP, pascalCase, camelCase } from "./utils.js";
import {
  ClassView,
  EnumView,
  InterfaceView,
  PropertyView,
  Renderer,
  TemplateName,
  TemplateOverrides,
  createRenderer,
  renderDocComment,
} from "./renderer.js";
import {
  ControllerGroup,
  ControllerOptions,
  collectControllers,
} from "./controllers.js";

/** Default C# namespace used for top-level TypeSpec models with no namespace. */
const DEFAULT_NAMESPACE = "Models";

/** `using` directives included in every model / interface / enum file. */
const SYSTEM_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Text.Json.Serialization",
];

/** `using` directives included in every controller and service file. */
const CONTROLLER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Threading.Tasks",
  "Microsoft.AspNetCore.Mvc",
];

/** `using` directives included in the MergePatch helper file. */
const MERGE_PATCH_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Reflection",
  "System.Text.Json",
  "System.Text.Json.Serialization",
  "System.Threading",
  "System.Threading.Tasks",
];

/** `using` directives included in the EnumMemberConverter helper file. */
const ENUM_CONVERTER_HELPER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Reflection",
  "System.Runtime.Serialization",
  "System.Text.Json",
  "System.Text.Json.Serialization",
];

/** `using` directives included in every service interface file. */
const SERVICE_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Threading.Tasks",
];

/** `using` directives included in every enum file. */
const ENUM_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Runtime.Serialization",
  "System.Text.Json.Serialization",
];

// ── Validator template support ───────────────────────────────────────────────

/** Absolute path to the bundled templates directory (shared with renderer). */
const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates",
);

// Lazily compiled Handlebars validator templates — each loaded on first use.
let _compiledValidatorPostTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPatchTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPostVersionAwareTemplate:
  | Handlebars.TemplateDelegate
  | undefined;
let _compiledValidatorPatchVersionAwareTemplate:
  | Handlebars.TemplateDelegate
  | undefined;
let _compiledValidatorInitializerTemplate:
  | Handlebars.TemplateDelegate
  | undefined;

function loadValidatorTemplate(path: string): Handlebars.TemplateDelegate {
  return Handlebars.compile(readFileSync(path, "utf-8"));
}

function getValidatorPostTemplate(
  override?: string,
): Handlebars.TemplateDelegate {
  if (override) return loadValidatorTemplate(override);
  return (_compiledValidatorPostTemplate ??= loadValidatorTemplate(
    resolve(TEMPLATES_DIR, "validator-post.hbs"),
  ));
}
function getValidatorPatchTemplate(
  override?: string,
): Handlebars.TemplateDelegate {
  if (override) return loadValidatorTemplate(override);
  return (_compiledValidatorPatchTemplate ??= loadValidatorTemplate(
    resolve(TEMPLATES_DIR, "validator-patch.hbs"),
  ));
}
function getValidatorPostVersionAwareTemplate(
  override?: string,
): Handlebars.TemplateDelegate {
  if (override) return loadValidatorTemplate(override);
  return (_compiledValidatorPostVersionAwareTemplate ??= loadValidatorTemplate(
    resolve(TEMPLATES_DIR, "validator-post-version-aware.hbs"),
  ));
}
function getValidatorPatchVersionAwareTemplate(
  override?: string,
): Handlebars.TemplateDelegate {
  if (override) return loadValidatorTemplate(override);
  return (_compiledValidatorPatchVersionAwareTemplate ??= loadValidatorTemplate(
    resolve(TEMPLATES_DIR, "validator-patch-version-aware.hbs"),
  ));
}
function getValidatorInitializerTemplate(
  override?: string,
): Handlebars.TemplateDelegate {
  if (override) return loadValidatorTemplate(override);
  return (_compiledValidatorInitializerTemplate ??= loadValidatorTemplate(
    resolve(TEMPLATES_DIR, "validator-initializer.hbs"),
  ));
}

// ── Validator data types (ported from tsp-fluent-validators) ─────────────────

/**
 * Carries the formatted value of a numeric constraint so that Handlebars'
 * `{{#if numericRule}}` resolves to `true` even when the value is `0`.
 */
interface NumericRule {
  value: number;
  formatted: string;
}

/** Structured rule data for a single model property. */
interface PropertyData {
  name: string;
  hasRules: boolean;
  notEmpty: boolean;
  /** True when the property is read-only (not writable for the target lifecycle). */
  isReadOnly?: boolean;
  /**
   * True when the C# property can hold `null` after deserialization of an
   * absent field. When `false`, `.Null()` would always fail — the read-only
   * rejection rule is skipped for this property in POST validators.
   */
  nullable: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  emailAddress: boolean;
  isInEnum: boolean;
  enumTypeName?: string;
  minValue?: NumericRule;
  maxValue?: NumericRule;
  referencedModelName?: string;
  /** Kept for FQ name computation; not serialized to Handlebars templates. */
  referencedModel?: Model;
  referencedParamName?: string;
  isCollectionReference?: boolean;
}

/** Validator for a referenced child model (injected as constructor parameter). */
interface ReferencedValidator {
  modelName: string;
  qualifiedModelName: string;
  paramName: string;
}

/** Data passed to the Handlebars POST / PATCH validator template. */
interface ValidatorTemplateData {
  namespace?: string;
  modelName: string;
  /** Fully-qualified C# type name of the validated model (e.g. `MyApp.Models.Pet`). */
  qualifiedModelName: string;
  /** C# type name of the validated PATCH body (e.g. `MergePatch<Pet>`). Only set for patch validators. */
  patchBodyTypeName?: string;
  /** Fully-qualified C# type name of the PATCH body (e.g. `MergePatch<MyApp.Models.Pet>`). Only set for patch validators. */
  qualifiedPatchBodyTypeName?: string;
  /** C# namespace for the MergePatch helper (used for the `using` directive in PATCH templates). Only set for patch validators. */
  helpersNamespace?: string;
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  properties: PropertyData[];
  referencedValidators?: ReferencedValidator[];
}

/** A group of properties added in a specific API version. */
interface VersionGroup {
  sinceVersion: string;
  properties: PropertyData[];
}

/** Data passed to the version-aware Handlebars validator templates. */
interface VersionAwareValidatorTemplateData {
  namespace?: string;
  modelName: string;
  /** Fully-qualified C# type name of the validated model (e.g. `MyApp.Models.Pet`). */
  qualifiedModelName: string;
  /** C# type name of the validated PATCH body (e.g. `MergePatch<Pet>`). Only set for patch validators. */
  patchBodyTypeName?: string;
  /** Fully-qualified C# type name of the PATCH body (e.g. `MergePatch<MyApp.Models.Pet>`). Only set for patch validators. */
  qualifiedPatchBodyTypeName?: string;
  /** C# namespace for the MergePatch helper (used for the `using` directive in PATCH templates). Only set for patch validators. */
  helpersNamespace?: string;
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  allVersions: string[];
  defaultVersion: string;
  baseProperties: PropertyData[];
  versionGroups: VersionGroup[];
  referencedValidators?: ReferencedValidator[];
}

/** One entry in the generated `ValidatorsInitializer`. */
interface ValidatorRegistration {
  modelTypeName: string;
  qualifiedModelTypeName: string;
  validatorName: string;
}

/** Data passed to the `ValidatorsInitializer` Handlebars template. */
interface InitializerTemplateData {
  namespace?: string;
  registrations: ValidatorRegistration[];
  isVersionAware: boolean;
}

/**
 * Fully-resolved emitter configuration, derived from raw {@link EmitterOptions}
 * and the `EmitContext`.  All paths are absolute; all optional fields have
 * defaults applied.
 */
interface ResolvedOptions {
  /** Value of `root-namespace`, or `undefined` if not configured. */
  rootNamespace: string | undefined;
  /**
   * Inferred or explicitly configured global root namespace.
   * Equals `root-namespace` when set, otherwise inferred from the TypeSpec namespace tree.
   */
  effectiveRootNamespace: string | undefined;
  /** Verbatim C# namespace for all model and enum files. */
  modelsNamespace: string;
  /** Verbatim C# namespace for all interface files (always equals modelsNamespace). */
  interfacesNamespace: string;
  /** Verbatim C# namespace for all controller files. */
  controllersNamespace: string;
  /** Verbatim C# namespace for all service files. */
  servicesNamespace: string;
  /** Verbatim C# namespace for all validator files (version suffix may be appended). */
  validatorsNamespace: string;
  /** Verbatim C# namespace for all helper files. */
  helpersNamespace: string;
  /** Sorted namespace-map entries (longest key first for longest-match wins). */
  namespaceMap: Array<{ key: string; value: string }>;
  /** File extension for all emitted files, e.g. `".g.cs"`. */
  fileExtension: string;
  /** Absolute path to the models output directory. */
  modelsOutputDir: string;
  /** Whether to emit `I<Model>` interface files. */
  emitInterfaces: boolean;
  /** Absolute path to the interfaces output directory. */
  interfacesOutputDir: string;
  /** Whether to emit controller base class files. */
  emitControllers: boolean;
  /** Absolute path to the controllers output directory. */
  controllersOutputDir: string;
  /** Whether to emit service interface files. */
  emitServices: boolean;
  /** Absolute path to the services output directory. */
  servicesOutputDir: string;
  /** Route prefix prepended to every controller route. */
  routePrefix: string;
  /** Extra `using` namespaces appended to every file. */
  additionalUsings: string[];
  /** Whether to emit all properties as nullable C# types. */
  nullableProperties: boolean;
  /** Suffix appended to generated abstract class names. */
  abstractSuffix: string;
  /** Whether to add a CancellationToken parameter to operations. */
  cancellationToken: boolean;
  /** Resolved template override paths (absolute). */
  templates: TemplateOverrides;
  /** Whether to emit helper files (`MergePatchValue`, `EnumMemberConverter`). */
  emitHelpers: boolean;
  /** Absolute path to the helpers output directory. */
  helpersOutputDir: string;
  /** When `true`, model/enum/interface files are placed flat in their output dir; otherwise placed in TypeSpec-namespace-mirrored subdirectories. */
  namespaceFromPath: boolean;
  /** Whether to emit FluentValidation validator files. */
  emitValidators: boolean;
  /** Absolute path to the validators output directory. */
  validatorsOutputDir: string;
  /** Which validator type(s) to emit: "post", "patch", or "both". */
  validatorsTypes: "post" | "patch" | "both";
  /**
   * Version strategy for validator generation.
   * `undefined` means auto-detect: "version-aware" when `@versioned` is present,
   * "earliest" otherwise.
   */
  validatorsVersionStrategy:
    | "earliest"
    | "latest"
    | "per-version"
    | "version-aware"
    | undefined;
  /** Whether to emit a shared generic helper or per-entity typed classes for MergePatch support. */
  mergePatchStyle: "generic" | "typed";
}

/** Inferred enum derived from a string-literal union property. */
interface InferredEnum {
  /** Enum type name. */
  name: string;
  /** C# namespace where the enum file is emitted. */
  namespace: string;
  /** Folder under models output dir. */
  folder: string[];
  /** Literal member wire values (e.g. ["red", "blue"]). */
  values: string[];
}

/**
 * TypeSpec emitter entry point.  Called once per emit run by the TypeSpec
 * compiler.
 *
 * Emits:
 * - One `<Model>.g.cs` and `I<Model>.g.cs` per TypeSpec model.
 * - One `<Name>.g.cs` per TypeSpec enum.
 * - One controller file and one service-interface file per HTTP operation
 *   container.
 *
 * @param context - Emit context provided by the TypeSpec compiler, carrying the
 *   compiled program, resolved options, and output directory path.
 */
export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  if (context.program.compilerOptions.noEmit) {
    return;
  }

  const program = context.program;
  const options = resolveOptions(context);

  const renderer = buildRenderer(program, options);
  if (!renderer) return;

  // ── Models & enums ──────────────────────────────────────────────────────────
  const models: Model[] = [];
  const enums: Enum[] = [];

  navigateProgram(program, {
    model(model) {
      if (shouldEmitModel(model) && !isMergePatch(program, model))
        models.push(model);
    },
    enum(en) {
      if (shouldEmitEnum(en)) enums.push(en);
    },
  });

  const inferredEnums = collectInferredEnums(models, enums, options);

  for (const model of models) {
    // All models and interfaces share a flat namespace.
    const classNs = options.modelsNamespace;
    const interfaceNs = options.interfacesNamespace;
    // File placement: flat when namespace-from-path is enabled; subdirs otherwise.
    const typespecNs = csharpNamespaceFor(
      model.namespace,
      options,
      options.effectiveRootNamespace,
    );
    const classFolder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecNs);
    const interfaceFolder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecNs);
    const refs = modelReferences(model);
    const classUsings = collectUsings(classNs, refs, options);
    const interfaceUsings = collectUsings(interfaceNs, refs, options);

    const emittedModelName =
      getServerName(program, model) ?? pascalCase(model.name);
    const classFileName = `${emittedModelName}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...classFolder, classFileName),
      content: renderer.renderFile({
        fileName: classFileName,
        namespace: classNs,
        usings: classUsings,
        body: renderer.renderClass(buildClassView(program, model, options)),
      }),
    });

    if (options.emitInterfaces) {
      const interfaceFileModelName = emittedModelName.startsWith("@")
        ? emittedModelName.slice(1)
        : emittedModelName;
      const interfaceFileName = `I${interfaceFileModelName}${options.fileExtension}`;
      await emitFile(program, {
        path: resolvePath(
          options.interfacesOutputDir,
          ...interfaceFolder,
          interfaceFileName,
        ),
        content: renderer.renderFile({
          fileName: interfaceFileName,
          namespace: interfaceNs,
          usings: interfaceUsings,
          body: renderer.renderInterface(
            buildInterfaceView(program, model, options),
          ),
        }),
      });
    }
  }

  for (const en of enums) {
    const ns = options.modelsNamespace;
    const typespecEnumNs = csharpNamespaceFor(
      en.namespace,
      options,
      options.effectiveRootNamespace,
    );
    const folder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecEnumNs);
    const emittedEnumName = pascalCase(en.name);
    const enumFileName = `${emittedEnumName}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...folder, enumFileName),
      content: renderer.renderFile({
        fileName: enumFileName,
        namespace: ns,
        usings: collectEnumUsings(ns, options),
        body: renderer.renderEnum(buildEnumView(program, en)),
      }),
    });
  }

  for (const inferred of inferredEnums) {
    const enumFileName = `${inferred.name}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(
        options.modelsOutputDir,
        ...inferred.folder,
        enumFileName,
      ),
      content: renderer.renderFile({
        fileName: enumFileName,
        namespace: inferred.namespace,
        usings: collectEnumUsings(inferred.namespace, options),
        body: renderer.renderEnum(buildInferredEnumView(inferred)),
      }),
    });
  }

  // ── Controllers & services ──────────────────────────────────────────────────
  const controllerOptions: ControllerOptions = {
    routePrefix: options.routePrefix,
    nullableProperties: options.nullableProperties,
    abstractSuffix: options.abstractSuffix,
    cancellationToken: options.cancellationToken,
    mergePatchStyle: options.mergePatchStyle,
  };

  const groups = collectControllers(
    program,
    controllerOptions,
    (ns) => csharpNamespaceFor(ns, options),
    (ns) => folderSegments(options.effectiveRootNamespace, ns),
  );

  for (const group of groups) {
    await emitControllerGroup(program, group, renderer, options);
  }

  // Collect patch models for MergePatch emission (generic helper or per-entity classes).
  const patchRouteModels = collectValidatorModelsFromRoutes(program, models);

  if (options.mergePatchStyle === "typed") {
    if (patchRouteModels?.patchModels.size) {
      await emitEntityMergePatches(
        program,
        patchRouteModels.patchModels,
        renderer,
        options,
      );
    }
  } else {
    await emitMergePatch(program, renderer, options);
  }

  // Emit EnumMemberConverter helper only when emit-helpers is true (optional).
  if (options.emitHelpers) {
    await emitEnumMemberConverter(program, renderer, options);
  }

  // ── Validators ──────────────────────────────────────────────────────────────
  if (options.emitValidators) {
    await emitValidators(context, program, options);
  }
}

// ── Validator helper functions (ported from tsp-fluent-validators) ───────────

/**
 * Returns true if all variants of a union are string literals.
 * Used to apply `NotEmpty()` to required union-typed properties.
 */
function isStringLiteralUnion(type: Type): boolean {
  if (type.kind !== "Union") return false;
  const union = type as Union;
  for (const [, variant] of union.variants) {
    if (variant.type.kind !== "String") return false;
  }
  return union.variants.size > 0;
}

/** Returns true if the given Type is a string scalar or derives from one. */
function isStringScalar(type: Type): boolean {
  if (type.kind !== "Scalar") return false;
  let current: Scalar | undefined = type as Scalar;
  while (current !== undefined) {
    if (current.name === "string") return true;
    current = current.baseScalar;
  }
  return false;
}

/**
 * Returns `true` when a C# property can realistically hold `null` after
 * `System.Text.Json` deserialises a request body that omits the field.
 *
 * - If the property is TypeSpec-optional, the C# type always has `?` → null.
 * - If `nullable-properties: true` (the default), every property is `T?` → null.
 * - Reference types (`string`, `byte[]`, `Uri`, model classes, arrays) hold null
 *   even without an explicit `?` annotation.
 * - C# value-type scalars (`bool`, `int`, `Guid`, `DateTimeOffset`, …) mapped from
 *   TypeSpec scalars or `@format` annotations are **non-nullable** unless either of
 *   the above conditions applies.
 */
function isNullableForValidator(
  program: Program,
  prop: ModelProperty,
  nullableProperties: boolean,
): boolean {
  if (prop.optional || nullableProperties) return true;

  const VALUE_TYPE_SCALAR_NAMES = new Set([
    "boolean",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "safeint",
    "integer",
    "float",
    "float32",
    "float64",
    "decimal",
    "decimal128",
    "numeric",
    "plainDate",
    "plainTime",
    "utcDateTime",
    "offsetDateTime",
    "duration",
  ]);
  const VALUE_TYPE_FORMATS = new Set([
    "uuid",
    "guid",
    "date-time",
    "date",
    "time",
  ]);

  const format = (
    getFormat(program, prop) ?? getFormat(program, prop.type)
  )?.toLowerCase();
  if (format && VALUE_TYPE_FORMATS.has(format)) return false;

  if (prop.type.kind === "Scalar") {
    let current: Scalar | undefined = prop.type as Scalar;
    while (current !== undefined) {
      if (VALUE_TYPE_SCALAR_NAMES.has(current.name)) return false;
      current = current.baseScalar;
    }
  }

  return true;
}

/**
 * Returns true if the model should be excluded from validator emission:
 * anonymous models, generic template declarations, template instances,
 * or models from TypeSpec built-in / external package namespaces.
 */
function shouldSkipValidatorModel(model: Model): boolean {
  if (!model.name) return true;
  if (isTemplateDeclaration(model)) return true;
  if (isTemplateInstance(model)) return true;
  let ns = model.namespace;
  while (ns) {
    if (ns.name === "TypeSpec") return true;
    ns = ns.namespace;
  }
  const filePath: string =
    (model.node as { file?: { path?: string } } | undefined)?.file?.path ?? "";
  return filePath.replace(/\\/g, "/").includes("node_modules/");
}

/**
 * If `type` is a user-defined model or an array of user-defined models, returns
 * the referenced model and whether it is a collection. Returns `undefined` for
 * scalars, enums, unions, built-in models, and arrays of non-models.
 */
function getValidatorModelReference(
  type: Type,
): { model: Model; isCollection: boolean } | undefined {
  if (type.kind !== "Model") return undefined;
  const m = type as Model;
  if (m.indexer !== undefined) {
    const elemType = m.indexer.value;
    if (!elemType || elemType.kind !== "Model") return undefined;
    const elemModel = elemType as Model;
    if (shouldSkipValidatorModel(elemModel)) return undefined;
    return { model: elemModel, isCollection: true };
  }
  if (shouldSkipValidatorModel(m)) return undefined;
  return { model: m, isCollection: false };
}

/** Extracts all constraint data for a single model property. */
function buildSinglePropertyData(
  program: Program,
  prop: ModelProperty,
  isReadOnly = false,
  nullableProperties = true,
): PropertyData {
  const hasDefault = prop.defaultValue !== undefined;
  const notEmpty =
    !isReadOnly &&
    !prop.optional &&
    !hasDefault &&
    (isStringScalar(prop.type) || isStringLiteralUnion(prop.type));
  const minLength =
    getMinLength(program, prop) ?? getMinLength(program, prop.type);
  const maxLength =
    getMaxLength(program, prop) ?? getMaxLength(program, prop.type);
  const pattern = getPattern(program, prop) ?? getPattern(program, prop.type);
  const format = getFormat(program, prop) ?? getFormat(program, prop.type);
  const emailAddress = format === "email";

  const isInEnum = prop.type.kind === "Enum";
  const enumTypeName = isInEnum
    ? pascalCase((prop.type as Enum).name)
    : undefined;

  const rawMin = getMinValue(program, prop) ?? getMinValue(program, prop.type);
  const rawMax = getMaxValue(program, prop) ?? getMaxValue(program, prop.type);
  const minValue: NumericRule | undefined =
    rawMin !== undefined
      ? { value: rawMin, formatted: String(rawMin) }
      : undefined;
  const maxValue: NumericRule | undefined =
    rawMax !== undefined
      ? { value: rawMax, formatted: String(rawMax) }
      : undefined;

  const modelRef = getValidatorModelReference(prop.type);
  const referencedModelName = modelRef
    ? (getServerName(program, modelRef.model) ??
      pascalCase(modelRef.model.name))
    : undefined;
  const referencedParamName = referencedModelName
    ? referencedModelName.charAt(0).toLowerCase() +
      referencedModelName.slice(1) +
      "Validator"
    : undefined;
  const isCollectionReference = modelRef?.isCollection;

  const hasRules =
    isReadOnly ||
    notEmpty ||
    minLength !== undefined ||
    maxLength !== undefined ||
    pattern !== undefined ||
    emailAddress ||
    isInEnum ||
    minValue !== undefined ||
    maxValue !== undefined ||
    referencedModelName !== undefined;

  return {
    name: getServerName(program, prop) ?? pascalCase(prop.name),
    hasRules,
    notEmpty,
    isReadOnly: isReadOnly || undefined,
    nullable: isNullableForValidator(program, prop, nullableProperties),
    minLength,
    maxLength,
    pattern,
    emailAddress,
    isInEnum: isReadOnly ? false : isInEnum,
    enumTypeName: isReadOnly ? undefined : enumTypeName,
    minValue: isReadOnly ? undefined : minValue,
    maxValue: isReadOnly ? undefined : maxValue,
    referencedModelName: isReadOnly ? undefined : referencedModelName,
    referencedModel: isReadOnly ? undefined : modelRef?.model,
    referencedParamName: isReadOnly ? undefined : referencedParamName,
    isCollectionReference: isReadOnly ? undefined : isCollectionReference,
  };
}

/**
 * Builds the `PropertyData` array for all properties of a model,
 * respecting lifecycle visibility and an optional version filter.
 * Read-only (non-writable) properties are included with `isReadOnly: true`
 * so validators can emit a rejection rule for them.
 */
function buildValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  visibilityMember?: EnumMember,
  versionFilter?: (prop: ModelProperty) => boolean,
  nullableProperties = true,
): PropertyData[] {
  const result: PropertyData[] = [];
  for (const [, prop] of model.properties) {
    const isWritable =
      writeMembers.size === 0 ||
      isVisible(program, prop, { any: writeMembers });

    if (!isWritable) {
      // Include read-only property so the validator can reject it.
      result.push(
        buildSinglePropertyData(program, prop, true, nullableProperties),
      );
      continue;
    }
    if (
      visibilityMember &&
      !isVisible(program, prop, { any: new Set([visibilityMember]) })
    ) {
      continue;
    }
    if (versionFilter && !versionFilter(prop)) continue;
    result.push(
      buildSinglePropertyData(program, prop, false, nullableProperties),
    );
  }
  return result;
}

/**
 * Builds version-aware property data (base properties + versioned groups)
 * for the `"version-aware"` strategy.
 * Read-only (non-writable) properties are included with `isReadOnly: true`
 * so validators can emit a rejection rule for them.
 */
function buildVersionAwareValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  visibilityMember: EnumMember | undefined,
  allVersions: Version[],
  nullableProperties = true,
): { baseProperties: PropertyData[]; versionGroups: VersionGroup[] } {
  const baseProperties: PropertyData[] = [];
  const groupMap = new Map<string, PropertyData[]>();

  for (const [, prop] of model.properties) {
    const isWritable =
      writeMembers.size === 0 ||
      isVisible(program, prop, { any: writeMembers });

    if (!isWritable) {
      baseProperties.push(
        buildSinglePropertyData(program, prop, true, nullableProperties),
      );
      continue;
    }
    if (
      visibilityMember &&
      !isVisible(program, prop, { any: new Set([visibilityMember]) })
    ) {
      continue;
    }
    const propData = buildSinglePropertyData(
      program,
      prop,
      false,
      nullableProperties,
    );
    const availMap = getAvailabilityMap(program, prop);
    if (availMap === undefined) {
      baseProperties.push(propData);
      continue;
    }
    let addedVersionName: string | undefined;
    for (const ver of allVersions) {
      if (availMap.get(ver.name) === Availability.Added) {
        addedVersionName = ver.name;
        break;
      }
    }
    if (!addedVersionName || addedVersionName === allVersions[0].name) {
      baseProperties.push(propData);
    } else {
      const bucket = groupMap.get(addedVersionName) ?? [];
      bucket.push(propData);
      groupMap.set(addedVersionName, bucket);
    }
  }

  const versionGroups: VersionGroup[] = [];
  for (const ver of allVersions.slice(1)) {
    const props = groupMap.get(ver.name);
    if (props && props.length > 0) {
      versionGroups.push({ sinceVersion: ver.value, properties: props });
    }
  }
  return { baseProperties, versionGroups };
}

/**
 * Returns a predicate that accepts a `ModelProperty` if it is available at
 * the named version. Properties with no version metadata are always accepted.
 */
function makeValidatorVersionFilter(
  program: Program,
  versionName: string,
): (prop: ModelProperty) => boolean {
  return (prop) => {
    const availMap = getAvailabilityMap(program, prop);
    if (availMap === undefined) return true;
    const avail = availMap.get(versionName);
    return avail === Availability.Added || avail === Availability.Available;
  };
}

/** Collects unique `ReferencedValidator` entries from one or more property lists. */
function deriveReferencedValidators(
  program: Program,
  options: ResolvedOptions,
  ...propertyGroups: PropertyData[][]
): ReferencedValidator[] {
  const seen = new Set<string>();
  const result: ReferencedValidator[] = [];
  for (const props of propertyGroups) {
    for (const p of props) {
      if (p.referencedModelName && !seen.has(p.referencedModelName)) {
        seen.add(p.referencedModelName);
        const qualifiedModelName = p.referencedModel
          ? computeModelFqName(program, p.referencedModel, options)
          : p.referencedModelName;
        result.push({
          modelName: p.referencedModelName,
          qualifiedModelName,
          paramName: p.referencedParamName!,
        });
      }
    }
  }
  return result;
}

/**
 * BFS from `initialModels` following model-typed properties, returning the full
 * transitive closure of reachable user-defined models.
 */
function collectValidatorTransitiveDeps(
  program: Program,
  initialModels: Set<Model>,
  versionFilter?: (prop: ModelProperty) => boolean,
): Set<Model> {
  const all = new Set<Model>(initialModels);
  const queue = [...initialModels];
  while (queue.length > 0) {
    const model = queue.shift()!;
    for (const [, prop] of model.properties) {
      if (versionFilter && !versionFilter(prop)) continue;
      const ref = getValidatorModelReference(prop.type);
      if (ref && !all.has(ref.model)) {
        all.add(ref.model);
        queue.push(ref.model);
      }
    }
  }
  return all;
}

/** Adds the given model and all its direct descendants to the target set. */
function addModelWithDescendants(
  allModels: Model[],
  model: Model,
  target: Set<Model>,
): void {
  target.add(model);
  for (const candidate of allModels) {
    if (candidate.baseModel === model) target.add(candidate);
  }
}

/**
 * Collects the sets of models that appear as POST and PATCH request bodies
 * across all HTTP services. Returns `undefined` when no HTTP operations exist,
 * signalling the caller to fall back to all models.
 *
 * For PATCH, `patchModels` maps each source model to the C# name of the actual
 * PATCH body type (e.g. `Pet` → `"PetMergePatchUpdate"` for a MergePatch body,
 * or `"Pet"` for a plain PATCH body).
 */
function collectValidatorModelsFromRoutes(
  program: Program,
  allModels: Model[],
): { postModels: Set<Model>; patchModels: Map<Model, string> } | undefined {
  const [services] = getAllHttpServices(program);
  const hasAnyOperations = services.some((s) => s.operations.length > 0);
  if (!hasAnyOperations) return undefined;

  const postModels = new Set<Model>();
  const patchModels = new Map<Model, string>();

  for (const service of services) {
    for (const op of service.operations) {
      if (op.verb !== "post" && op.verb !== "patch") continue;
      const body = op.parameters.body;
      if (!body || body.bodyKind !== "single") continue;
      const bodyType = (body as HttpOperationBody).type;
      if (bodyType.kind !== "Model") continue;
      const bodyModel = bodyType as Model;
      if (op.verb === "post") {
        addModelWithDescendants(allModels, bodyModel, postModels);
      } else {
        const isMergePatchBody = isMergePatch(program, bodyModel);
        const sourceModel = isMergePatchBody
          ? getMergePatchSource(program, bodyModel)
          : bodyModel;
        if (sourceModel) {
          const sourceName =
            getServerName(program, sourceModel) ?? pascalCase(sourceModel.name);
          const bodyTypeName = isMergePatchBody
            ? `MergePatch<${sourceName}>`
            : sourceName;
          patchModels.set(sourceModel, bodyTypeName);
          // Also register direct descendants, deriving their patch body type name.
          for (const candidate of allModels) {
            if (candidate.baseModel === sourceModel) {
              const candidateName =
                getServerName(program, candidate) ?? pascalCase(candidate.name);
              const descBodyTypeName = isMergePatchBody
                ? `MergePatch<${candidateName}>`
                : candidateName;
              patchModels.set(candidate, descBodyTypeName);
            }
          }
        }
      }
    }
  }
  return { postModels, patchModels };
}

// ── Internal validator emission helpers ──────────────────────────────────────

/**
 * Resolves display and qualified type names for a PATCH body given the raw
 * entry from `patchModels` (e.g. `"MergePatch<Widget>"` or a plain model name).
 *
 * For `merge-patch-style: "generic"` the generic helper class is used.
 * For `merge-patch-style: "typed"` a per-entity `{Model}MergePatchUpdate` class is used.
 */
function resolvePatchBodyInfo(
  rawBodyTypeName: string,
  modelName: string,
  qualifiedModelName: string,
  options: ResolvedOptions,
): {
  patchBodyTypeName: string;
  /** Fully-qualified form for use in `AbstractValidator<T>` (may embed generic args). */
  qualifiedPatchBodyTypeName: string;
  /** Namespace added as a `using` directive in patch validator files; `undefined` when not needed. */
  helpersNamespace: string | undefined;
  /** Fully-qualified type for DI registration in `ValidatorsInitializer`. */
  fullyQualifiedTypeName: string;
} {
  const isMergePatchBody = rawBodyTypeName.startsWith("MergePatch<");
  if (!isMergePatchBody) {
    return {
      patchBodyTypeName: rawBodyTypeName,
      qualifiedPatchBodyTypeName: qualifiedModelName,
      helpersNamespace: undefined,
      fullyQualifiedTypeName: qualifiedModelName,
    };
  }
  if (options.mergePatchStyle === "typed") {
    const typedName = `${modelName}MergePatchUpdate`;
    const fullyQualified = `${options.modelsNamespace}.${modelName}MergePatchUpdate`;
    return {
      patchBodyTypeName: typedName,
      qualifiedPatchBodyTypeName: fullyQualified,
      helpersNamespace: undefined,
      fullyQualifiedTypeName: fullyQualified,
    };
  }
  // Generic style
  return {
    patchBodyTypeName: rawBodyTypeName,
    qualifiedPatchBodyTypeName: `MergePatch<${qualifiedModelName}>`,
    helpersNamespace: options.helpersNamespace || undefined,
    fullyQualifiedTypeName: `${options.helpersNamespace}.MergePatch<${qualifiedModelName}>`,
  };
}

interface EmitValidatorSingleOptions {
  versionFilter?: (prop: ModelProperty) => boolean;
  versionDirName?: string;
  versionNsSuffix?: string;
}

function resolveValidatorNamespace(
  options: ResolvedOptions,
  versionNsSuffix?: string,
): string | undefined {
  let ns: string | undefined = options.validatorsNamespace || undefined;
  if (versionNsSuffix) {
    ns = ns ? `${ns}.${versionNsSuffix}` : versionNsSuffix;
  }
  return ns;
}

/** Emits standard (non-version-aware) POST and/or PATCH validators. */
async function emitValidatorModels(
  program: Program,
  allModels: Model[],
  routeModels:
    | { postModels: Set<Model>; patchModels: Map<Model, string> }
    | undefined,
  createMember: EnumMember | undefined,
  updateMember: EnumMember | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  singleOpts: EmitValidatorSingleOptions = {},
): Promise<void> {
  const { versionFilter, versionDirName, versionNsSuffix } = singleOpts;
  const namespace = resolveValidatorNamespace(options, versionNsSuffix);
  const writeMembers = new Set(
    [createMember, updateMember].filter(
      (m): m is EnumMember => m !== undefined,
    ),
  );

  for (const model of allModels) {
    const versionDir = versionDirName ? `${versionDirName}/` : "";

    const doPost =
      emitPost &&
      (routeModels === undefined || routeModels.postModels.has(model));
    const doPatch =
      emitPatch &&
      (routeModels === undefined || routeModels.patchModels.has(model));

    const qualifiedModelName = computeModelFqName(program, model, options);
    const modelName = getServerName(program, model) ?? pascalCase(model.name);

    if (doPost) {
      const postProps = buildValidatorProperties(
        program,
        model,
        writeMembers,
        createMember,
        versionFilter,
        options.nullableProperties,
      );
      const postRefs = deriveReferencedValidators(program, options, postProps);
      const data: ValidatorTemplateData = {
        namespace,
        modelName,
        qualifiedModelName,
        properties: postProps,
        referencedValidators: postRefs.length > 0 ? postRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${versionDir}${modelName}Validator${options.fileExtension}`,
        ),
        content: getValidatorPostTemplate(options.templates["validator-post"])(
          data,
        ),
      });
    }

    if (doPatch) {
      const rawBodyTypeName = routeModels?.patchModels.get(model) ?? modelName;
      const {
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        helpersNamespace,
        fullyQualifiedTypeName: _fqt,
      } = resolvePatchBodyInfo(
        rawBodyTypeName,
        modelName,
        qualifiedModelName,
        options,
      );
      const isMergePatchBody = rawBodyTypeName.startsWith("MergePatch<");
      const patchProps = buildValidatorProperties(
        program,
        model,
        writeMembers,
        updateMember,
        versionFilter,
        options.nullableProperties,
      );
      const patchRefs = isMergePatchBody
        ? []
        : deriveReferencedValidators(program, options, patchProps);
      const data: ValidatorTemplateData = {
        namespace,
        modelName,
        qualifiedModelName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        helpersNamespace,
        isMergePatchBody: isMergePatchBody || undefined,
        properties: patchProps,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${versionDir}${modelName}PatchValidator${options.fileExtension}`,
        ),
        content: getValidatorPatchTemplate(
          options.templates["validator-patch"],
        )(data),
      });
    }
  }
}

/** Emits version-aware POST and/or PATCH validators. */
async function emitVersionAwareValidatorModels(
  program: Program,
  allModels: Model[],
  routeModels:
    | { postModels: Set<Model>; patchModels: Map<Model, string> }
    | undefined,
  createMember: EnumMember | undefined,
  updateMember: EnumMember | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  allVersions: Version[],
): Promise<void> {
  const versionValues = allVersions.map((v) => v.value);
  const defaultVersion = versionValues[0];
  const namespace = resolveValidatorNamespace(options);
  const writeMembers = new Set(
    [createMember, updateMember].filter(
      (m): m is EnumMember => m !== undefined,
    ),
  );

  for (const model of allModels) {
    const doPost =
      emitPost &&
      (routeModels === undefined || routeModels.postModels.has(model));
    const doPatch =
      emitPatch &&
      (routeModels === undefined || routeModels.patchModels.has(model));

    const qualifiedModelName = computeModelFqName(program, model, options);
    const modelName = getServerName(program, model) ?? pascalCase(model.name);

    if (doPost) {
      const { baseProperties, versionGroups } =
        buildVersionAwareValidatorProperties(
          program,
          model,
          writeMembers,
          createMember,
          allVersions,
          options.nullableProperties,
        );
      const postRefs = deriveReferencedValidators(
        program,
        options,
        baseProperties,
        ...versionGroups.map((g) => g.properties),
      );
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelName,
        qualifiedModelName,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: postRefs.length > 0 ? postRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${modelName}Validator${options.fileExtension}`,
        ),
        content: getValidatorPostVersionAwareTemplate(
          options.templates["validator-post-version-aware"],
        )(data),
      });
    }

    if (doPatch) {
      const rawBodyTypeName = routeModels?.patchModels.get(model) ?? modelName;
      const {
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        helpersNamespace,
        fullyQualifiedTypeName: _fqt,
      } = resolvePatchBodyInfo(
        rawBodyTypeName,
        modelName,
        qualifiedModelName,
        options,
      );
      const isMergePatchBody = rawBodyTypeName.startsWith("MergePatch<");
      const { baseProperties, versionGroups } =
        buildVersionAwareValidatorProperties(
          program,
          model,
          writeMembers,
          updateMember,
          allVersions,
          options.nullableProperties,
        );
      const patchRefs = isMergePatchBody
        ? []
        : deriveReferencedValidators(
            program,
            options,
            baseProperties,
            ...versionGroups.map((g) => g.properties),
          );
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelName,
        qualifiedModelName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        helpersNamespace,
        isMergePatchBody: isMergePatchBody || undefined,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${modelName}PatchValidator${options.fileExtension}`,
        ),
        content: getValidatorPatchVersionAwareTemplate(
          options.templates["validator-patch-version-aware"],
        )(data),
      });
    }
  }
}

interface EmitValidatorInitializerOptions {
  versionDirName?: string;
  versionNsSuffix?: string;
}

/** Emits `ValidatorsInitializer.g.cs`. */
async function emitValidatorsInitializer(
  program: Program,
  allModels: Model[],
  routeModels:
    | { postModels: Set<Model>; patchModels: Map<Model, string> }
    | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  isVersionAware: boolean,
  initOpts: EmitValidatorInitializerOptions = {},
): Promise<void> {
  const { versionDirName, versionNsSuffix } = initOpts;

  const registrations: ValidatorRegistration[] = [];
  for (const model of allModels) {
    const qualifiedModelName = computeModelFqName(program, model, options);
    const modelName = getServerName(program, model) ?? pascalCase(model.name);

    if (
      emitPost &&
      (routeModels === undefined || routeModels.postModels.has(model))
    ) {
      registrations.push({
        modelTypeName: modelName,
        qualifiedModelTypeName: qualifiedModelName,
        validatorName: `${modelName}Validator`,
      });
    }
    if (
      emitPatch &&
      (routeModels === undefined || routeModels.patchModels.has(model))
    ) {
      const rawBodyTypeName = routeModels?.patchModels.get(model) ?? modelName;
      const { patchBodyTypeName, fullyQualifiedTypeName } =
        resolvePatchBodyInfo(
          rawBodyTypeName,
          modelName,
          qualifiedModelName,
          options,
        );
      registrations.push({
        modelTypeName: patchBodyTypeName,
        qualifiedModelTypeName: fullyQualifiedTypeName,
        validatorName: `${modelName}PatchValidator`,
      });
    }
  }

  if (registrations.length === 0) return;

  let namespace: string | undefined = options.validatorsNamespace || undefined;
  if (versionNsSuffix) {
    namespace = namespace ? `${namespace}.${versionNsSuffix}` : versionNsSuffix;
  }

  const versionDir = versionDirName ? `${versionDirName}/` : "";

  const data: InitializerTemplateData = {
    namespace,
    registrations,
    isVersionAware,
  };
  await emitFile(program, {
    path: resolvePath(
      options.validatorsOutputDir,
      `${versionDir}ValidatorsInitializer${options.fileExtension}`,
    ),
    content: getValidatorInitializerTemplate(
      options.templates["validator-initializer"],
    )(data),
  });
}

/**
 * Entry point for validator emission. Called from `$onEmit` when
 * `emit-validators` is `true`.
 */
async function emitValidators(
  context: EmitContext<EmitterOptions>,
  program: Program,
  options: ResolvedOptions,
): Promise<void> {
  const emitPost =
    options.validatorsTypes === "post" || options.validatorsTypes === "both";
  const emitPatch =
    options.validatorsTypes === "patch" || options.validatorsTypes === "both";

  // Collect all user-defined, non-template models.
  const allModels: Model[] = [];
  navigateProgram(program, {
    model(model) {
      if (!shouldSkipValidatorModel(model)) allModels.push(model);
    },
  });

  const routeModels = collectValidatorModelsFromRoutes(program, allModels);

  const lifecycle = getLifecycleVisibilityEnum(program);
  const createMember = lifecycle.members.get("Create");
  const updateMember = lifecycle.members.get("Update");

  // Detect versioning.
  let allVersions: Version[] | undefined;
  for (const model of allModels) {
    const versions = getAllVersions(program, model);
    if (versions && versions.length > 0) {
      allVersions = versions;
      break;
    }
  }

  const effectiveStrategy =
    options.validatorsVersionStrategy ??
    (allVersions ? "version-aware" : "earliest");

  if (effectiveStrategy === "latest") {
    reportDiagnostic(program, {
      code: "version-strategy-breaking",
      target: NoTarget,
      format: {},
    });
  }

  if (
    effectiveStrategy === "per-version" &&
    allVersions &&
    allVersions.length > 0
  ) {
    for (const version of allVersions) {
      const vf = makeValidatorVersionFilter(program, version.name);
      const versionNsSuffix =
        version.name.charAt(0).toUpperCase() + version.name.slice(1);
      const expandedRouteModels = routeModels
        ? {
            postModels: collectValidatorTransitiveDeps(
              program,
              routeModels.postModels,
              vf,
            ),
            patchModels: routeModels.patchModels,
          }
        : undefined;
      await emitValidatorModels(
        program,
        allModels,
        expandedRouteModels,
        createMember,
        updateMember,
        options,
        emitPost,
        emitPatch,
        { versionFilter: vf, versionDirName: version.name, versionNsSuffix },
      );
      await emitValidatorsInitializer(
        program,
        allModels,
        expandedRouteModels,
        options,
        emitPost,
        emitPatch,
        /* isVersionAware */ false,
        { versionDirName: version.name, versionNsSuffix },
      );
    }
  } else if (
    effectiveStrategy === "version-aware" &&
    allVersions &&
    allVersions.length > 0
  ) {
    const expandedRouteModels = routeModels
      ? {
          postModels: collectValidatorTransitiveDeps(
            program,
            routeModels.postModels,
          ),
          patchModels: routeModels.patchModels,
        }
      : undefined;
    await emitVersionAwareValidatorModels(
      program,
      allModels,
      expandedRouteModels,
      createMember,
      updateMember,
      options,
      emitPost,
      emitPatch,
      allVersions,
    );
    await emitValidatorsInitializer(
      program,
      allModels,
      expandedRouteModels,
      options,
      emitPost,
      emitPatch,
      /* isVersionAware */ true,
    );
  } else {
    // "earliest" or "latest" (or no versioning)
    let versionFilter: ((prop: ModelProperty) => boolean) | undefined;
    if (allVersions && allVersions.length > 0) {
      const targetVersionName =
        effectiveStrategy === "latest"
          ? allVersions[allVersions.length - 1].name
          : allVersions[0].name;
      versionFilter = makeValidatorVersionFilter(program, targetVersionName);
    }
    const expandedRouteModels = routeModels
      ? {
          postModels: collectValidatorTransitiveDeps(
            program,
            routeModels.postModels,
            versionFilter,
          ),
          patchModels: routeModels.patchModels,
        }
      : undefined;
    await emitValidatorModels(
      program,
      allModels,
      expandedRouteModels,
      createMember,
      updateMember,
      options,
      emitPost,
      emitPatch,
      { versionFilter },
    );
    await emitValidatorsInitializer(
      program,
      allModels,
      expandedRouteModels,
      options,
      emitPost,
      emitPatch,
      /* isVersionAware */ false,
    );
  }
}

// ── Controller / service emission helpers ────────────────────────────────────

/**
 * Writes the controller file and the service-interface file for one
 * {@link ControllerGroup}.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param group - The controller group to emit.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options (for output paths and extension).
 */
async function emitControllerGroup(
  program: Program,
  group: ControllerGroup,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const { controllerView, serviceView } = group;

  const ctrlNamespace = options.controllersNamespace;
  const svcNamespace = options.servicesNamespace;
  const folder: string[] = [];

  if (options.emitControllers) {
    const controllerFileName = `${controllerView.controllerName}${options.fileExtension}`;
    const ctrlUsings = buildControllerUsings(
      program,
      options,
      group.references,
      ctrlNamespace,
    );
    await emitFile(program, {
      path: resolvePath(
        options.controllersOutputDir,
        ...folder,
        controllerFileName,
      ),
      content: renderer.renderFile({
        fileName: controllerFileName,
        namespace: ctrlNamespace,
        usings: ctrlUsings,
        body: renderer.renderController(controllerView),
      }),
    });
  }

  if (options.emitServices) {
    const serviceInterfaceFileName = `${serviceView.interfaceName}${options.fileExtension}`;
    const svcUsings = buildServiceUsings(
      program,
      options,
      group.references,
      svcNamespace,
    );
    await emitFile(program, {
      path: resolvePath(
        options.servicesOutputDir,
        ...folder,
        serviceInterfaceFileName,
      ),
      content: renderer.renderFile({
        fileName: serviceInterfaceFileName,
        namespace: svcNamespace,
        usings: svcUsings,
        body: renderer.renderServiceInterface(serviceView),
      }),
    });
  }
}

/**
 * Writes the shared generic `MergePatch<T>` helper class to the helpers output
 * directory. Only called when `merge-patch-style` is `"generic"` (the default).
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitMergePatch(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const mergePatchFileName = `MergePatch${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, mergePatchFileName),
    content: renderer.renderFile({
      fileName: mergePatchFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(MERGE_PATCH_USINGS)),
      body: renderer.renderMergePatch(),
    }),
  });
}

/**
 * Writes one `{ModelName}MergePatchUpdate` file per entity in `patchModels` to the
 * models output directory. Only called when `merge-patch-style` is `"typed"`.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param patchModels - Map of source models to their raw body type names.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitEntityMergePatches(
  program: Program,
  patchModels: Map<Model, string>,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  for (const [model, rawTypeName] of patchModels) {
    if (!rawTypeName.startsWith("MergePatch<")) continue;
    const modelName = getServerName(program, model) ?? pascalCase(model.name);
    const qualifiedModelName = computeModelFqName(program, model, options);
    const fileName = `${modelName}MergePatchUpdate${options.fileExtension}`;
    const typespecNs = csharpNamespaceFor(
      model.namespace,
      options,
      options.effectiveRootNamespace,
    );
    const classFolder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecNs);
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...classFolder, fileName),
      content: renderer.renderFile({
        fileName,
        namespace: options.modelsNamespace,
        usings: sortUsings(new Set(MERGE_PATCH_USINGS)),
        body: renderer.renderEntityMergePatch({
          modelName,
          qualifiedModelName,
        }),
      }),
    });
  }
}

/**
 * Writes the `EnumMemberConverter` helper class to the helpers output
 * directory. This is only emitted when the `emit-helpers` option is enabled.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitEnumMemberConverter(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const enumConverterFileName = `EnumMemberConverter${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, enumConverterFileName),
    content: renderer.renderFile({
      fileName: enumConverterFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(ENUM_CONVERTER_HELPER_USINGS)),
      body: renderer.renderEnumMemberConverter(),
    }),
  });
}

/**
 * Builds the sorted list of `using` namespaces for a generated controller file.
 *
 * Includes {@link CONTROLLER_USINGS}, any `additional-usings` from options,
 * namespaces for all types referenced by the operations, and the helpers
 * namespace when any reference is a `MergePatch<T>` body type.
 *
 * @param program - The compiled TypeSpec program (needed for MergePatch detection).
 * @param options - Resolved emitter options (additional usings).
 * @param references - TypeSpec types referenced by controller operations.
 * @param ownNamespace - The C# namespace of the controller file being emitted.
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildControllerUsings(
  program: Program,
  options: ResolvedOptions,
  references: Type[],
  ownNamespace: string,
): string[] {
  const usings = new Set<string>(CONTROLLER_USINGS);
  if (options.cancellationToken) usings.add("System.Threading");
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    if (ref.kind === "Model" && isMergePatch(program, ref as Model)) {
      if (
        options.mergePatchStyle !== "typed" &&
        options.helpersNamespace &&
        options.helpersNamespace !== ownNamespace
      ) {
        usings.add(options.helpersNamespace);
      }
    }
    for (const _type of collectReferencedTypes(ref)) {
      const ns = options.modelsNamespace;
      if (ns && ns !== ownNamespace) usings.add(ns);
    }
  }
  return sortUsings(usings);
}

/**
 * Builds the sorted list of `using` namespaces for a generated service interface file.
 *
 * Includes base service usings (System, System.Collections.Generic, System.Threading.Tasks),
 * any `additional-usings` from options, namespaces for all types referenced by operations,
 * and the helpers namespace when any reference is a `MergePatch<T>` body type.
 *
 * @param program - The compiled TypeSpec program (needed for MergePatch detection).
 * @param options - Resolved emitter options (additional usings).
 * @param references - TypeSpec types referenced by service operations.
 * @param ownNamespace - The C# namespace of the service file being emitted.
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildServiceUsings(
  program: Program,
  options: ResolvedOptions,
  references: Type[],
  ownNamespace: string,
): string[] {
  const usings = new Set<string>(SERVICE_USINGS);
  if (options.cancellationToken) usings.add("System.Threading");
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    if (ref.kind === "Model" && isMergePatch(program, ref as Model)) {
      if (
        options.mergePatchStyle !== "typed" &&
        options.helpersNamespace &&
        options.helpersNamespace !== ownNamespace
      ) {
        usings.add(options.helpersNamespace);
      }
    }
    for (const _type of collectReferencedTypes(ref)) {
      const ns = options.modelsNamespace;
      if (ns && ns !== ownNamespace) usings.add(ns);
    }
  }
  return sortUsings(usings);
}

/**
 * Sorts a set of `using` namespace strings with `System` namespaces first,
 * then alphabetically within each group.
 *
 * @param set - Unsorted set of namespace strings.
 * @returns Sorted array of namespace strings.
 */
function sortUsings(set: Set<string>): string[] {
  return [...set].sort((a, b) => {
    const aSystem = a === "System" || a.startsWith("System.");
    const bSystem = b === "System" || b.startsWith("System.");
    if (aSystem !== bSystem) return aSystem ? -1 : 1;
    return a.localeCompare(b);
  });
}

/**
 * Instantiates the Handlebars renderer, reporting a structured diagnostic if
 * any template cannot be loaded.
 *
 * @param program - The compiled TypeSpec program (used to report diagnostics).
 * @param options - Resolved options carrying template override paths.
 * @returns A renderer instance, or `undefined` if template loading failed.
 */
function buildRenderer(
  program: Program,
  options: ResolvedOptions,
): Renderer | undefined {
  try {
    return createRenderer(options.templates);
  } catch (err) {
    const path = findFailingTemplatePath(options.templates, err);
    const name = (Object.entries(options.templates).find(
      ([, p]) => p === path,
    )?.[0] ?? "unknown") as TemplateName;
    reportDiagnostic(program, {
      code: "template-load-failed",
      target: NoTarget,
      format: {
        name,
        path: path ?? "",
        reason: err instanceof Error ? err.message : String(err),
      },
    });
    return undefined;
  }
}

/**
 * Searches the error message of a failed template load to identify which
 * override path caused the failure.
 *
 * @param templates - Map of template name to override path.
 * @param err - The error thrown during template loading.
 * @returns The failing path string, or `undefined` if it cannot be inferred.
 */
function findFailingTemplatePath(
  templates: TemplateOverrides,
  err: unknown,
): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  for (const value of Object.values(templates)) {
    if (value && message.includes(value)) return value;
  }
  return undefined;
}

/**
 * Derives a C# namespace from a root namespace and a relative output directory
 * path.  Each path segment is PascalCased and joined with dots.
 *
 * @param rootNs - Configured `root-namespace`, or `undefined`.
 * @param rawDir - Relative output directory, e.g. `"Controllers"` or `"src/api"`.
 * @returns Dot-separated C# namespace string.
 *
 * @example
 * pathNamespace("MyApp", "Controllers") // → "MyApp.Controllers"
 * pathNamespace(undefined, "Services")  // → "Services"
 */
/**
 * Returns the fully-qualified C# class name for a model, using the same
 * namespace logic as class file emission (TypeSpec namespace + optional dir suffix).
 */
function computeModelFqName(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): string {
  const classNs = options.modelsNamespace;
  const className = getServerName(program, model) ?? pascalCase(model.name);
  return classNs ? `${classNs}.${className}` : className;
}

/**
 * Infers the effective root namespace from the TypeSpec program when
 * `root-namespace` is not explicitly configured.
 *
 * Collects all top-level user namespaces (direct children of the TypeSpec
 * global namespace) and, when there is exactly one, descends through any
 * single-child chains to find the deepest common ancestor — i.e. the most
 * specific namespace shared by all user-defined types.
 *
 * Examples:
 * - `namespace Demo;` → `"Demo"`
 * - `namespace My.App;` → `"My.App"`
 * - `namespace App.Models {} namespace App.Services {}` → `"App"` (common root)
 * - *(no namespace declaration)* → `undefined`
 *
 * @param program - The compiled TypeSpec program.
 * @returns The inferred root namespace string, or `undefined`.
 */
function inferRootNamespace(program: Program): string | undefined {
  // Collect direct children of the global namespace (which has no parent).
  // The global namespace node itself has ns.namespace === undefined; its direct
  // children satisfy: ns.namespace is defined AND ns.namespace.namespace is undefined.
  const topLevel: Namespace[] = [];
  navigateProgram(program, {
    namespace(ns) {
      if (!isStdNamespace(ns) && ns.namespace && !ns.namespace.namespace) {
        topLevel.push(ns);
      }
    },
  });

  // Ambiguous (multiple top-level user namespaces, e.g. across separate tsp files
  // with distinct root names) or absent — cannot infer.
  if (topLevel.length !== 1) return undefined;

  // Walk the single-child chain downward to find the most specific common root.
  function walk(ns: Namespace): Namespace {
    const children = [...ns.namespaces.values()].filter(
      (n) => !isStdNamespace(n),
    );
    // Single child: keep descending.  Zero or multiple children: this is the
    // deepest common ancestor, return it.
    return children.length === 1 ? walk(children[0]) : ns;
  }

  const result = walk(topLevel[0]);
  return getNamespaceFullName(result) || undefined;
}

/**
 * Converts raw {@link EmitterOptions} from the `EmitContext` into a
 * fully-resolved {@link ResolvedOptions} object.
 *
 * - Relative output directories are resolved against the emitter output dir.
 * - Namespace-map entries are sorted longest-key-first.
 * - All optional values receive their documented defaults.
 * - When `root-namespace` is not set, the TypeSpec namespace is inferred from
 *   the program and used as the root for controller, service, and helper
 *   path-namespace calculations.
 *
 * @param context - The TypeSpec emit context.
 * @returns Resolved options ready for use throughout the emit phase.
 */
function resolveOptions(context: EmitContext<EmitterOptions>): ResolvedOptions {
  const raw = context.options;
  const baseDir = context.emitterOutputDir;
  const map = raw["namespace-map"] ?? {};
  const namespaceMap = Object.entries(map)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.key.length - a.key.length);
  // Default output directories are "Models" for models/interfaces, and "Controllers"/"Services"/"Helpers" for others.
  // When namespace-from-path is enabled, the dir suffixes are always applied to the namespace
  // to reflect the output directory path (e.g., "MyApp.Models", "MyApp.Controllers").
  const modelsDir = raw["models-output-dir"] ?? "Models";
  const interfacesDir = raw["interfaces-output-dir"] ?? "Models";
  const controllersDir = raw["controllers-output-dir"] ?? "Controllers";
  const servicesDir = raw["services-output-dir"] ?? "Services";
  const helpersDir = raw["helpers-output-dir"] ?? "Helpers";
  const validatorsDir = raw["validators-output-dir"] ?? "Validators";
  const rootNs = raw["root-namespace"];
  // When the user does not supply root-namespace, infer it from the TypeSpec
  // namespace tree so that generated files automatically receive a
  // properly-qualified namespace (e.g. "MyApp.Controllers").
  const effectiveRootNs = rootNs ?? inferRootNamespace(context.program);
  // Determine if we should use namespace-from-path mode (controls file placement only).
  const useNamespaceFromPath = raw["namespace-from-path"] ?? false;

  // Each section has an explicit namespace option. When not set, synthesize
  // from effectiveRootNs + the conventional suffix segment.
  const modelsNamespace =
    raw["models-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Models` : "Models");
  const controllersNamespace =
    raw["controllers-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Controllers` : "Controllers");
  const servicesNamespace =
    raw["services-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Services` : "Services");
  const validatorsNamespace =
    raw["validators-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Validators` : "Validators");
  const helpersNamespace =
    raw["helpers-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Helpers` : "Helpers");

  return {
    rootNamespace: rootNs,
    effectiveRootNamespace: effectiveRootNs,
    modelsNamespace,
    interfacesNamespace: modelsNamespace,
    controllersNamespace,
    servicesNamespace,
    validatorsNamespace,
    helpersNamespace,
    namespaceMap,
    fileExtension: raw["file-extension"] ?? ".g.cs",
    modelsOutputDir: resolvePath(baseDir, modelsDir),
    emitInterfaces: raw["emit-interfaces"] ?? false,
    interfacesOutputDir: resolvePath(baseDir, interfacesDir),
    emitControllers: raw["emit-controllers"] ?? true,
    controllersOutputDir: resolvePath(baseDir, controllersDir),
    emitServices: raw["emit-services"] ?? true,
    servicesOutputDir: resolvePath(baseDir, servicesDir),
    emitHelpers: raw["emit-helpers"] ?? false,
    helpersOutputDir: resolvePath(baseDir, helpersDir),
    routePrefix: raw["route-prefix"] ?? "api/{version}",
    namespaceFromPath: useNamespaceFromPath,
    additionalUsings: raw["additional-usings"] ?? [],
    nullableProperties: raw["nullable-properties"] ?? true,
    abstractSuffix: raw["abstract-suffix"] ?? "Base",
    cancellationToken: raw["cancellation-token"] ?? true,
    templates: resolveTemplatePaths(raw.templates),
    emitValidators: raw["emit-validators"] ?? false,
    validatorsOutputDir: resolvePath(baseDir, validatorsDir),
    validatorsTypes: raw["validators"] ?? "both",
    validatorsVersionStrategy: raw["validators-version-strategy"],
    mergePatchStyle: raw["merge-patch-style"] ?? "generic",
  };
}

/**
 * Converts the raw `templates` option values (relative paths as the user types
 * them) to absolute paths that the renderer can use directly.
 *
 * @param templates - Raw template override map from user config.
 * @returns Template override map with all paths made absolute.
 */
function resolveTemplatePaths(
  templates: EmitterOptions["templates"],
): TemplateOverrides {
  if (!templates) return {};
  const out: TemplateOverrides = {};
  const keys: (keyof TemplateOverrides)[] = [
    "file",
    "class",
    "interface",
    "enum",
    "controller",
    "service-interface",
    "merge-patch",
    "entity-merge-patch",
    "enum-member-converter",
    "validator-post",
    "validator-patch",
    "validator-post-version-aware",
    "validator-patch-version-aware",
    "validator-initializer",
  ];
  for (const name of keys) {
    const value = templates[name as keyof typeof templates];
    if (value) out[name] = resolvePath(process.cwd(), value);
  }
  return out;
}

/**
 * Returns `true` for models that should produce a class and interface file.
 *
 * Filters out unnamed models, standard-library types, arrays, records, and
 * template declarations.
 *
 * @param model - TypeSpec model node.
 * @returns Whether the model should be emitted.
 */
function shouldEmitModel(model: Model): boolean {
  if (!model.name) return false;
  if (isInStdNamespace(model.namespace)) return false;
  if (isArrayModelType(model)) return false;
  if (isRecordModelType(model)) return false;
  if (isTemplateDeclaration(model)) return false;
  return true;
}

/**
 * Returns `true` for enums that should produce a file.
 *
 * Filters out unnamed enums and standard-library types.
 *
 * @param en - TypeSpec enum node.
 * @returns Whether the enum should be emitted.
 */
function shouldEmitEnum(en: Enum): boolean {
  if (!en.name) return false;
  if (isInStdNamespace(en.namespace)) return false;
  return true;
}

/**
 * Returns `true` if the given namespace (or any of its ancestors) is a
 * TypeSpec standard-library namespace.
 *
 * @param ns - Namespace node to test, or `undefined` for the global namespace.
 * @returns Whether the namespace is part of the TypeSpec standard library.
 */
function isInStdNamespace(ns: Namespace | undefined): boolean {
  let current: Namespace | undefined = ns;
  while (current) {
    if (isStdNamespace(current)) return true;
    current = current.namespace;
  }
  return false;
}

/**
 * Returns the fully-qualified TypeSpec namespace name, or an empty string for
 * the global namespace.
 *
 * @param ns - Namespace node, or `undefined`.
 * @returns Dot-separated namespace string.
 */
function namespaceFullName(ns: Namespace | undefined): string {
  if (!ns) return "";
  return getNamespaceFullName(ns) || "";
}

/**
 * Maps a TypeSpec namespace node to the C# namespace string used in generated
 * files.
 *
 * Applies the namespace-map (longest-match) and PascalCases each segment.
 * For top-level types (no TypeSpec namespace) the fallback order is:
 *   1. `sectionRootNs` — per-section root override when provided.
 *   2. `root-namespace` — the global root namespace when set.
 *   3. `DEFAULT_NAMESPACE` (`"Models"`) — the hard-coded default.
 *
 * @param ns - TypeSpec namespace node, or `undefined`.
 * @param options - Resolved options carrying the namespace map and root.
 * @param sectionRootNs - Optional per-section root (e.g. `models-root-namespace`)
 *   that takes priority over the global root for unnamespaced types.
 * @returns Dot-separated C# namespace string.
 */
function csharpNamespaceFor(
  ns: Namespace | undefined,
  options: ResolvedOptions,
  sectionRootNs?: string,
): string {
  const fullNs = namespaceFullName(ns);
  if (!fullNs)
    return sectionRootNs ?? options.rootNamespace ?? DEFAULT_NAMESPACE;
  const mapped = applyNamespaceMap(fullNs, options.namespaceMap);
  return mapped.split(".").map(pascalCase).join(".");
}

/**
 * Applies the namespace-map to a fully-qualified TypeSpec namespace string.
 *
 * Entries are tested longest-key-first so that more-specific mappings win over
 * shorter prefix mappings.
 *
 * @param fullNs - Fully-qualified TypeSpec namespace string.
 * @param map - Pre-sorted namespace-map entries.
 * @returns The rewritten namespace, or the original if no entry matched.
 */
function applyNamespaceMap(
  fullNs: string,
  map: Array<{ key: string; value: string }>,
): string {
  for (const { key, value } of map) {
    if (fullNs === key) return value;
    if (fullNs.startsWith(key + ".")) return value + fullNs.slice(key.length);
  }
  return fullNs;
}

/**
 * Converts a C# namespace string to the relative folder path segments used
 * when placing files under the output directory.
 *
 * When `root-namespace` is set, strips that prefix from the namespace and
 * splits the remainder into segments.  Returns an empty array when:
 * - No `root-namespace` is configured.
 * - The namespace equals the root (file goes in the output root).
 * - The namespace does not start with the root prefix.
 *
 * @param rootNs - The configured `root-namespace`, or `undefined`.
 * @param csharpNs - The C# namespace for the type being emitted.
 * @returns Array of folder name segments (may be empty).
 */
function folderSegments(
  rootNs: string | undefined,
  csharpNs: string,
): string[] {
  if (!rootNs) return [];
  if (csharpNs === rootNs) return [];
  if (csharpNs.startsWith(rootNs + ".")) {
    return csharpNs.slice(rootNs.length + 1).split(".");
  }
  return [];
}

/**
 * Collects all TypeSpec types directly referenced by a model (base class and
 * all property types).
 *
 * @param model - The TypeSpec model node.
 * @returns Array of referenced TypeSpec type nodes.
 */
function modelReferences(model: Model): Type[] {
  const refs: Type[] = [];
  if (model.baseModel) refs.push(model.baseModel);
  for (const prop of model.properties.values()) {
    refs.push(prop.type);
  }
  return refs;
}

/**
 * Recursively yields all {@link Model} and {@link Enum} nodes reachable from a
 * single TypeSpec type reference.
 *
 * Used to collect the set of C# namespaces that need `using` directives.
 *
 * @param type - Starting TypeSpec type node.
 * @yields All transitively referenced model and enum types.
 */
function* collectReferencedTypes(type: Type): Generator<Model | Enum> {
  switch (type.kind) {
    case "Model":
      if (isArrayModelType(type) || isRecordModelType(type)) {
        yield* collectReferencedTypes(type.indexer.value);
      } else if (type.name) {
        yield type;
      }
      break;
    case "Enum":
      yield type;
      break;
    case "Union":
      for (const variant of type.variants.values()) {
        yield* collectReferencedTypes(variant.type);
      }
      break;
  }
}

/**
 * Builds the sorted list of `using` namespaces for a single emitted file.
 *
 * Starts from {@link SYSTEM_USINGS}, adds any `additional-usings`, then adds
 * the C# namespace for each transitively-referenced type that lives in a
 * different namespace.  Deduplicates and sorts (System first).
 *
 * @param ownNamespace - The C# namespace of the file being emitted.
 * @param references - TypeSpec type nodes referenced by the model.
 * @param options - Resolved options (namespace map, additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function collectUsings(
  ownNamespace: string,
  references: Type[],
  options: ResolvedOptions,
): string[] {
  const usings = new Set<string>(SYSTEM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  for (const _ref of references) {
    const ns = options.modelsNamespace;
    if (ns && ns !== ownNamespace) usings.add(ns);
  }
  return sortUsings(usings);
}

/**
 * Builds the sorted list of `using` namespaces for a generated enum file.
 *
 * Includes {@link ENUM_USINGS}, any `additional-usings`, and the helpers
 * namespace so that `EnumMemberConverterFactory` can be referenced.
 *
 * @param ownNamespace - The C# namespace of the enum file being emitted.
 * @param options - Resolved options (helpers namespace, additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function collectEnumUsings(
  ownNamespace: string,
  options: ResolvedOptions,
): string[] {
  const usings = new Set<string>(ENUM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  if (options.helpersNamespace && options.helpersNamespace !== ownNamespace) {
    usings.add(options.helpersNamespace);
  }
  return sortUsings(usings);
}

/**
 * Builds a {@link ClassView} from a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Populated class view model.
 */
function buildClassView(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): ClassView {
  const className = getServerName(program, model) ?? pascalCase(model.name);
  const safeClassName = className.startsWith("@")
    ? className.slice(1)
    : className;

  return {
    doc: docFor(program, model),
    className,
    interfaceName: options.emitInterfaces ? `I${safeClassName}` : undefined,
    baseClass: model.baseModel
      ? typeReference(model.baseModel, program)
      : undefined,
    properties: buildPropertyViews(program, model, options),
  };
}

/**
 * Builds an {@link InterfaceView} from a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Populated interface view model.
 */
function buildInterfaceView(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): InterfaceView {
  const ifaceName = getServerName(program, model) ?? pascalCase(model.name);
  const baseIfaceName = model.baseModel
    ? (getServerName(program, model.baseModel) ??
      pascalCase(model.baseModel.name))
    : undefined;
  return {
    doc: docFor(program, model),
    interfaceName: `I${ifaceName.startsWith("@") ? ifaceName.slice(1) : ifaceName}`,
    baseInterface: baseIfaceName
      ? `I${baseIfaceName.startsWith("@") ? baseIfaceName.slice(1) : baseIfaceName}`
      : undefined,
    properties: buildPropertyViews(program, model, options),
  };
}

/**
 * Builds an {@link EnumView} from a TypeSpec enum.
 *
 * @param program - The compiled TypeSpec program.
 * @param en - The TypeSpec enum node.
 * @returns Populated enum view model.
 */
function buildEnumView(program: Program, en: Enum): EnumView {
  const enumDoc = getDoc(program, en);
  return {
    doc: enumDoc ? renderDocComment(enumDoc) : undefined,
    enumName: pascalCase(en.name),
    members: [...en.members.values()].map((member) => {
      const memberDoc = getDoc(program, member);
      return {
        doc: memberDoc ? renderDocComment(memberDoc) : undefined,
        name: pascalCase(member.name),
        value: typeof member.value === "number" ? member.value : undefined,
        memberValue:
          typeof member.value === "string" ? member.value : member.name,
      };
    }),
  };
}

/**
 * Converts a TypeSpec default {@link Value} to a C# property initializer expression.
 *
 * Handles the value kinds that map cleanly to C# literals:
 * - `EnumValue`    → `EnumTypeName.MemberName`
 * - `StringValue`  → `"value"`
 * - `NumericValue` → `42` / `3.14`
 * - `BooleanValue` → `true` | `false`
 * - `NullValue`    → `null`
 *
 * Returns `undefined` for complex value kinds (objects, arrays, scalars) that
 * cannot be represented as a simple C# literal.
 *
 * @param value - The TypeSpec default value from `ModelProperty.defaultValue`.
 * @returns A C# initializer expression string, or `undefined` if unsupported.
 */
function defaultValueInitializer(value: Value): string | undefined {
  switch (value.valueKind) {
    case "EnumValue": {
      const member = value.value;
      return `${pascalCase(member.enum.name)}.${pascalCase(member.name)}`;
    }
    case "StringValue":
      return `"${value.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    case "NumericValue":
      return value.value.toString();
    case "BooleanValue":
      return value.value ? "true" : "false";
    case "NullValue":
      return "null";
    default:
      return undefined;
  }
}

/**
 * Builds the ordered array of {@link PropertyView} objects for all properties
 * of a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Array of property view models in declaration order.
 */
function buildPropertyViews(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): PropertyView[] {
  return [...model.properties.values()].map((prop) => {
    const type = propertyTypeName(program, model, prop, options);
    const inferredEnumType = inferredEnumTypeNameForProperty(model, prop);
    return {
      doc: docFor(program, prop),
      type,
      name: getServerName(program, prop) ?? pascalCase(prop.name),
      jsonName: camelCase(prop.name),
      nullable: type.endsWith("?"),
      initializer: resolveInitializer(prop.defaultValue, inferredEnumType),
    };
  });
}

/**
 * Resolves a C# property initializer expression for a default value.
 *
 * When the property has an inferred enum type and the default is a string
 * literal (anonymous string union), converts `"available"` → `PetStatus.Available`
 * instead of the raw string. Falls back to {@link defaultValueInitializer} for
 * all other cases.
 */
function resolveInitializer(
  value: Value | undefined,
  inferredEnumType: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (inferredEnumType && value.valueKind === "StringValue") {
    return `${inferredEnumType}.${pascalCase(value.value)}`;
  }
  return defaultValueInitializer(value);
}

/**
 * Retrieves and pre-renders the `@doc` annotation for a model or property.
 *
 * @param program - The compiled TypeSpec program.
 * @param target - The annotated model or model property.
 * @returns Pre-rendered XML summary string, or `undefined` if no doc is present.
 */
function docFor(
  program: Program,
  target: Model | ModelProperty,
): string | undefined {
  const doc = getDoc(program, target);
  return doc ? renderDocComment(doc) : undefined;
}

/**
 * Resolves the C# type string for a model property, including nullability.
 *
 * Checks `@format` annotations (on the property and its scalar type) before
 * falling through to {@link typeReference}.  Appends `?` when the property is
 * optional or when `nullable-properties` is enabled.
 *
 * @param program - The compiled TypeSpec program.
 * @param prop - The model property to resolve.
 * @param options - Resolved options for nullability and format mapping.
 * @returns C# type string, possibly suffixed with `?`.
 */
function propertyTypeName(
  program: Program,
  model: Model,
  prop: ModelProperty,
  options: ResolvedOptions,
): string {
  const propFormat = getFormat(program, prop);
  const scalarFormat =
    prop.type.kind === "Scalar" ? getFormat(program, prop.type) : undefined;
  const format = propFormat ?? scalarFormat;
  let type: string;
  if (format && FORMAT_MAP[format.toLowerCase()]) {
    type = FORMAT_MAP[format.toLowerCase()];
  } else {
    const inferredEnumType = inferredEnumTypeNameForProperty(model, prop);
    type = inferredEnumType ?? typeReference(prop.type, program);
  }
  const nullable = prop.optional || options.nullableProperties;
  return nullable && !type.endsWith("?") ? `${type}?` : type;
}

/**
 * Returns the inferred enum type name for a string-literal union property.
 *
 * For MergePatchUpdate models, uses the base model stem so
 * `WidgetMergePatchUpdate.color` resolves to `WidgetColor`.
 */
function inferredEnumTypeNameForProperty(
  model: Model,
  prop: ModelProperty,
): string | undefined {
  if (!getStringLiteralUnionValues(prop.type)) return undefined;
  return `${pascalCase(model.name)}${pascalCase(prop.name)}`;
}

/**
 * Returns string literal values from a union type (excluding null), or undefined.
 */
function getStringLiteralUnionValues(type: Type): string[] | undefined {
  if (type.kind !== "Union") return undefined;

  const values: string[] = [];
  for (const variant of type.variants.values()) {
    if (variant.type.kind === "Intrinsic" && variant.type.name === "null") {
      continue;
    }
    if (variant.type.kind !== "String") return undefined;
    if (typeof variant.type.value !== "string") return undefined;
    values.push(variant.type.value);
  }

  return values.length > 0 ? values : undefined;
}

/**
 * Collects inferred enums from model properties defined as string-literal unions.
 */
function collectInferredEnums(
  models: Model[],
  explicitEnums: Enum[],
  options: ResolvedOptions,
): InferredEnum[] {
  const byKey = new Map<string, InferredEnum>();
  const ns = options.modelsNamespace;
  const explicitEnumKeys = new Set(
    explicitEnums.map((en) => `${ns}.${pascalCase(en.name)}`),
  );

  for (const model of models) {
    const typespecNs = csharpNamespaceFor(model.namespace, options);
    const folder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecNs);

    for (const prop of model.properties.values()) {
      const values = getStringLiteralUnionValues(prop.type);
      if (!values) continue;

      const name = inferredEnumTypeNameForProperty(model, prop);
      if (!name) continue;

      const key = `${ns}.${name}`;
      if (explicitEnumKeys.has(key)) continue;
      if (!byKey.has(key)) {
        byKey.set(key, { name, namespace: ns, folder, values });
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Builds an {@link EnumView} for an inferred enum.
 */
function buildInferredEnumView(inferred: InferredEnum): EnumView {
  return {
    enumName: inferred.name,
    members: inferred.values.map((value) => ({
      name: pascalCase(value),
      memberValue: value,
    })),
  };
}

/**
 * Recursively resolves the C# type string for any TypeSpec {@link Type} node,
 * without applying nullability.
 *
 * When `program` is supplied, `@serverName` overrides on referenced models are
 * honoured so that renamed models are referenced by their C# identifier rather
 * than their TypeSpec name.
 *
 * @param type - The TypeSpec type node to resolve.
 * @param program - Optional compiled TypeSpec program used to look up `@serverName`.
 * @returns C# type string (non-nullable).
 */
function typeReference(type: Type, program?: Program): string {
  switch (type.kind) {
    case "Scalar": {
      const mapped = SCALAR_MAP[type.name];
      if (mapped) return mapped;
      let parent = type.baseScalar;
      while (parent) {
        const m = SCALAR_MAP[parent.name];
        if (m) return m;
        parent = parent.baseScalar;
      }
      return "object";
    }
    case "Model": {
      if (isArrayModelType(type)) {
        return `IList<${typeReference(type.indexer.value, program)}>`;
      }
      if (isRecordModelType(type)) {
        return `IDictionary<string, ${typeReference(type.indexer.value, program)}>`;
      }
      if (program && isMergePatch(program, type)) {
        const source = getMergePatchSource(program, type);
        if (source) {
          const sourceName =
            getServerName(program, source) ?? pascalCase(source.name);
          return `MergePatch<${sourceName}>`;
        }
      }
      return (
        (program ? getServerName(program, type) : undefined) ??
        pascalCase(type.name || "object")
      );
    }
    case "Enum":
      return pascalCase(type.name);
    case "Boolean":
      return "bool";
    case "String":
      return "string";
    case "Number":
      return "double";
    case "Union": {
      const variants = [...type.variants.values()];
      const nonNull = variants.filter(
        (v) => !(v.type.kind === "Intrinsic" && v.type.name === "null"),
      );
      const hasNull = nonNull.length !== variants.length;
      if (nonNull.length === 1) {
        const ref = typeReference(nonNull[0].type, program);
        return hasNull ? `${ref}?` : ref;
      }
      return "object";
    }
    case "Intrinsic":
      if (type.name === "null") return "object?";
      return "object";
    case "Tuple":
      return "object";
    default:
      return "object";
  }
}
