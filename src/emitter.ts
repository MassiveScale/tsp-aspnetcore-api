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
import { getMergePatchSource, isMergePatch } from "@typespec/http/experimental/merge-patch";
import { getAllVersions, getAvailabilityMap, Availability } from "@typespec/versioning";
import type { Version } from "@typespec/versioning";
import Handlebars from "handlebars";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { ControllerGroup, ControllerOptions, collectControllers } from "./controllers.js";

/** Default C# namespace used for top-level TypeSpec models with no namespace. */
const DEFAULT_NAMESPACE = "Models";

/** `using` directives included in every model / interface / enum file. */
const SYSTEM_USINGS = ["System", "System.Collections.Generic", "System.Text.Json.Serialization"];

/** `using` directives included in every controller and service file. */
const CONTROLLER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Threading.Tasks",
  "Microsoft.AspNetCore.Mvc",
];

/** `using` directives included in the MergePatchValue helper file. */
const HELPER_USINGS = ["System", "System.Text.Json", "System.Text.Json.Serialization"];

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
const SERVICE_USINGS = ["System", "System.Collections.Generic", "System.Threading.Tasks"];

/** `using` directives included in every enum file. */
const ENUM_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Runtime.Serialization",
  "System.Text.Json.Serialization",
];

// ── Validator template support ───────────────────────────────────────────────

/** Absolute path to the bundled templates directory (shared with renderer). */
const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../templates");

// Lazily compiled Handlebars validator templates — each loaded on first use.
let _compiledValidatorPostTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPatchTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPostVersionAwareTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPatchVersionAwareTemplate: Handlebars.TemplateDelegate | undefined;
let _compiledValidatorInitializerTemplate: Handlebars.TemplateDelegate | undefined;

function loadValidatorTemplate(name: string): Handlebars.TemplateDelegate {
  return Handlebars.compile(readFileSync(resolve(TEMPLATES_DIR, name), "utf-8"));
}

function getValidatorPostTemplate(): Handlebars.TemplateDelegate {
  return (_compiledValidatorPostTemplate ??= loadValidatorTemplate("validator-post.hbs"));
}
function getValidatorPatchTemplate(): Handlebars.TemplateDelegate {
  return (_compiledValidatorPatchTemplate ??= loadValidatorTemplate("validator-patch.hbs"));
}
function getValidatorPostVersionAwareTemplate(): Handlebars.TemplateDelegate {
  return (_compiledValidatorPostVersionAwareTemplate ??= loadValidatorTemplate("validator-post-version-aware.hbs"));
}
function getValidatorPatchVersionAwareTemplate(): Handlebars.TemplateDelegate {
  return (_compiledValidatorPatchVersionAwareTemplate ??= loadValidatorTemplate("validator-patch-version-aware.hbs"));
}
function getValidatorInitializerTemplate(): Handlebars.TemplateDelegate {
  return (_compiledValidatorInitializerTemplate ??= loadValidatorTemplate("validator-initializer.hbs"));
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
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  emailAddress: boolean;
  isInEnum: boolean;
  enumTypeName?: string;
  minValue?: NumericRule;
  maxValue?: NumericRule;
  referencedModelName?: string;
  referencedParamName?: string;
  isCollectionReference?: boolean;
}

/** Validator for a referenced child model (injected as constructor parameter). */
interface ReferencedValidator {
  modelName: string;
  paramName: string;
}

/** Data passed to the Handlebars POST / PATCH validator template. */
interface ValidatorTemplateData {
  namespace?: string;
  modelName: string;
  /** C# type name of the validated PATCH body (e.g. `PetMergePatchUpdate`). Only set for patch validators. */
  patchBodyTypeName?: string;
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
  /** C# type name of the validated PATCH body (e.g. `PetMergePatchUpdate`). Only set for patch validators. */
  patchBodyTypeName?: string;
  allVersions: string[];
  defaultVersion: string;
  baseProperties: PropertyData[];
  versionGroups: VersionGroup[];
  referencedValidators?: ReferencedValidator[];
}

/** One entry in the generated `ValidatorsInitializer`. */
interface ValidatorRegistration {
  modelTypeName: string;
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
  /** Resolved template override paths (absolute). */
  templates: TemplateOverrides;
  /** Whether to emit helper files (`MergePatchValue`, `EnumMemberConverter`). */
  emitHelpers: boolean;
  /** Absolute path to the helpers output directory. */
  helpersOutputDir: string;
  /** Whether to derive C# namespaces from output folder paths (controllers, services, helpers). */
  namespaceFromPath: boolean;
  /**
   * PascalCased namespace suffix derived from `models-output-dir` path segments
   * (e.g. `"models"` → `"Models"`, `"src/models"` → `"Src.Models"`).
   * Empty string when no `models-output-dir` is configured.
   */
  modelsDirSuffix: string;
  /**
   * PascalCased namespace suffix derived from `interfaces-output-dir` path segments.
   * Empty string when no `interfaces-output-dir` is configured.
   */
  interfacesDirSuffix: string;
  /** Path-derived namespace for controller files (used when `namespaceFromPath` is `true`). */
  controllersPathNamespace: string;
  /** Path-derived namespace for service files (used when `namespaceFromPath` is `true`). */
  servicesPathNamespace: string;
  /** C# namespace for helper files (always path-derived). */
  helpersNamespace: string;
  /** Whether to emit FluentValidation validator files. */
  emitValidators: boolean;
  /** Path-derived C# namespace for the ValidatorsInitializer file. */
  validatorsPathNamespace: string;
  /** Absolute path to the validators output directory. */
  validatorsOutputDir: string;
  /** Which validator type(s) to emit: "post", "patch", or "both". */
  validatorsTypes: "post" | "patch" | "both";
  /**
   * Version strategy for validator generation.
   * `undefined` means auto-detect: "version-aware" when `@versioned` is present,
   * "earliest" otherwise.
   */
  validatorsVersionStrategy: "earliest" | "latest" | "per-version" | "version-aware" | undefined;
  /** Whether to use namespace subdirectories for validator output files. */
  validatorsOutputSubdirectory: boolean;
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
export async function $onEmit(context: EmitContext<EmitterOptions>): Promise<void> {
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
      if (shouldEmitModel(model)) models.push(model);
    },
    enum(en) {
      if (shouldEmitEnum(en)) enums.push(en);
    },
  });

  const hasMergePatchUpdateModels = models.some(isMergePatchUpdateModel);
  const inferredEnums = collectInferredEnums(models, enums, options);

  for (const model of models) {
    const isMergePatchModel = isMergePatchUpdateModel(model);
    const typespecNs = csharpNamespaceFor(model.namespace, options);
    // When `namespaceFromPath` is enabled and an output-dir is configured,
    // append the PascalCased dir segments to the TypeSpec namespace so the C#
    // namespace reflects the physical output path
    // (e.g. "App.Users" + models-dir "models" → "App.Users.Models").
    // When no dir is configured, or `namespaceFromPath` is disabled, use the
    // TypeSpec namespace as-is and let `folderSegments` compute the sub-path.
    const classNs =
      options.namespaceFromPath && options.modelsDirSuffix
        ? `${typespecNs}.${options.modelsDirSuffix}`
        : typespecNs;
    const interfaceNs =
      options.namespaceFromPath && options.interfacesDirSuffix
        ? `${typespecNs}.${options.interfacesDirSuffix}`
        : typespecNs;
    // Flatten into the output dir when a suffix was applied; otherwise keep
    // the folderSegments sub-directory layout.
    const classFolder =
      options.namespaceFromPath && options.modelsDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecNs);
    const interfaceFolder =
      options.namespaceFromPath && options.interfacesDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecNs);
    const refs = modelReferences(model);
    // Pass modelsDirSuffix so that usings for referenced types also resolve to
    // the correct suffixed namespace.
    const classUsings = collectUsings(
      classNs,
      refs,
      options,
      options.modelsDirSuffix,
      isMergePatchModel,
    );
    const interfaceUsings = collectUsings(
      interfaceNs,
      refs,
      options,
      options.modelsDirSuffix,
      isMergePatchModel,
    );

    const classFileName = `${pascalCase(model.name)}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...classFolder, classFileName),
      content: renderer.renderFile({
        fileName: classFileName,
        namespace: classNs,
        usings: classUsings,
        body: renderer.renderClass(buildClassView(program, model, options, isMergePatchModel)),
      }),
    });

    if (options.emitInterfaces) {
      const interfaceFileName = `I${pascalCase(model.name)}${options.fileExtension}`;
      await emitFile(program, {
        path: resolvePath(options.interfacesOutputDir, ...interfaceFolder, interfaceFileName),
        content: renderer.renderFile({
          fileName: interfaceFileName,
          namespace: interfaceNs,
          usings: interfaceUsings,
          body: renderer.renderInterface(
            buildInterfaceView(program, model, options, isMergePatchModel),
          ),
        }),
      });
    }
  }

  for (const en of enums) {
    // Enums follow the same namespace strategy as model classes.
    const typespecEnumNs = csharpNamespaceFor(en.namespace, options);
    const ns =
      options.namespaceFromPath && options.modelsDirSuffix
        ? `${typespecEnumNs}.${options.modelsDirSuffix}`
        : typespecEnumNs;
    const folder =
      options.namespaceFromPath && options.modelsDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecEnumNs);
    const enumFileName = `${pascalCase(en.name)}${options.fileExtension}`;
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
      path: resolvePath(options.modelsOutputDir, ...inferred.folder, enumFileName),
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
  };

  const groups = collectControllers(
    program,
    controllerOptions,
    (ns) => csharpNamespaceFor(ns, options),
    (ns) => folderSegments(options.rootNamespace, ns),
  );

  for (const group of groups) {
    await emitControllerGroup(program, group, renderer, options);
  }

  // Emit MergePatchValue helper when any MergePatchUpdate models exist (required).
  if (hasMergePatchUpdateModels) {
    await emitMergePatchValue(program, renderer, options);
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
  const filePath: string = (model.node as { file?: { path?: string } } | undefined)?.file?.path ?? "";
  return filePath.replace(/\\/g, "/").includes("node_modules/");
}

/**
 * If `type` is a user-defined model or an array of user-defined models, returns
 * the referenced model and whether it is a collection. Returns `undefined` for
 * scalars, enums, unions, built-in models, and arrays of non-models.
 */
function getValidatorModelReference(type: Type): { model: Model; isCollection: boolean } | undefined {
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
function buildSinglePropertyData(program: Program, prop: ModelProperty): PropertyData {
  const hasDefault = prop.defaultValue !== undefined;
  const notEmpty = !prop.optional && !hasDefault && (isStringScalar(prop.type) || isStringLiteralUnion(prop.type));
  const minLength = getMinLength(program, prop) ?? getMinLength(program, prop.type);
  const maxLength = getMaxLength(program, prop) ?? getMaxLength(program, prop.type);
  const pattern = getPattern(program, prop) ?? getPattern(program, prop.type);
  const format = getFormat(program, prop) ?? getFormat(program, prop.type);
  const emailAddress = format === "email";

  const isInEnum = prop.type.kind === "Enum";
  const enumTypeName = isInEnum ? pascalCase((prop.type as Enum).name) : undefined;

  const rawMin = getMinValue(program, prop) ?? getMinValue(program, prop.type);
  const rawMax = getMaxValue(program, prop) ?? getMaxValue(program, prop.type);
  const minValue: NumericRule | undefined =
    rawMin !== undefined ? { value: rawMin, formatted: String(rawMin) } : undefined;
  const maxValue: NumericRule | undefined =
    rawMax !== undefined ? { value: rawMax, formatted: String(rawMax) } : undefined;

  const modelRef = getValidatorModelReference(prop.type);
  const referencedModelName = modelRef ? pascalCase(modelRef.model.name) : undefined;
  const referencedParamName = modelRef
    ? modelRef.model.name.charAt(0).toLowerCase() + modelRef.model.name.slice(1) + "Validator"
    : undefined;
  const isCollectionReference = modelRef?.isCollection;

  const hasRules =
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
    name: pascalCase(prop.name),
    hasRules,
    notEmpty,
    minLength,
    maxLength,
    pattern,
    emailAddress,
    isInEnum,
    enumTypeName,
    minValue,
    maxValue,
    referencedModelName,
    referencedParamName,
    isCollectionReference,
  };
}

/**
 * Builds the `PropertyData` array for all properties of a model,
 * respecting lifecycle visibility and an optional version filter.
 * Properties that are not writable (not visible for Create or Update)
 * are always excluded.
 */
function buildValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  visibilityMember?: EnumMember,
  versionFilter?: (prop: ModelProperty) => boolean,
): PropertyData[] {
  const result: PropertyData[] = [];
  for (const [, prop] of model.properties) {
    // Exclude read-only (non-writable) properties regardless of the lifecycle filter.
    if (writeMembers.size > 0 && !isVisible(program, prop, { any: writeMembers })) continue;
    if (visibilityMember && !isVisible(program, prop, { any: new Set([visibilityMember]) })) {
      continue;
    }
    if (versionFilter && !versionFilter(prop)) continue;
    result.push(buildSinglePropertyData(program, prop));
  }
  return result;
}

/**
 * Builds version-aware property data (base properties + versioned groups)
 * for the `"version-aware"` strategy.
 * Properties that are not writable (not visible for Create or Update)
 * are always excluded.
 */
function buildVersionAwareValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  visibilityMember: EnumMember | undefined,
  allVersions: Version[],
): { baseProperties: PropertyData[]; versionGroups: VersionGroup[] } {
  const baseProperties: PropertyData[] = [];
  const groupMap = new Map<string, PropertyData[]>();

  for (const [, prop] of model.properties) {
    // Exclude read-only (non-writable) properties regardless of the lifecycle filter.
    if (writeMembers.size > 0 && !isVisible(program, prop, { any: writeMembers })) continue;
    if (visibilityMember && !isVisible(program, prop, { any: new Set([visibilityMember]) })) {
      continue;
    }
    const propData = buildSinglePropertyData(program, prop);
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
function deriveReferencedValidators(...propertyGroups: PropertyData[][]): ReferencedValidator[] {
  const seen = new Set<string>();
  const result: ReferencedValidator[] = [];
  for (const props of propertyGroups) {
    for (const p of props) {
      if (p.referencedModelName && !seen.has(p.referencedModelName)) {
        seen.add(p.referencedModelName);
        result.push({ modelName: p.referencedModelName, paramName: p.referencedParamName! });
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
function addModelWithDescendants(allModels: Model[], model: Model, target: Set<Model>): void {
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
          patchModels.set(sourceModel, bodyModel.name);
          // Also register direct descendants, deriving their patch body type name.
          for (const candidate of allModels) {
            if (candidate.baseModel === sourceModel) {
              const descBodyTypeName = isMergePatchBody
                ? `${candidate.name}MergePatchUpdate`
                : candidate.name;
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

interface EmitValidatorSingleOptions {
  versionFilter?: (prop: ModelProperty) => boolean;
  versionDirName?: string;
  versionNsSuffix?: string;
}

/**
 * Resolves the C# namespace for a validator file, using the same path-based
 * logic as controllers and services (`validatorsPathNamespace`).
 */
function resolveValidatorNamespace(
  options: ResolvedOptions,
  versionNsSuffix?: string,
): string | undefined {
  let ns: string | undefined = options.validatorsPathNamespace || undefined;
  if (versionNsSuffix) {
    ns = ns ? `${ns}.${versionNsSuffix}` : versionNsSuffix;
  }
  return ns;
}

/** Emits standard (non-version-aware) POST and/or PATCH validators. */
async function emitValidatorModels(
  program: Program,
  allModels: Model[],
  routeModels: { postModels: Set<Model>; patchModels: Map<Model, string> } | undefined,
  createMember: EnumMember | undefined,
  updateMember: EnumMember | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  singleOpts: EmitValidatorSingleOptions = {},
): Promise<void> {
  const { versionFilter, versionDirName, versionNsSuffix } = singleOpts;
  const namespace = resolveValidatorNamespace(options, versionNsSuffix);
  const nsDir = options.validatorsOutputSubdirectory && namespace
    ? `${namespace.split(".").join("/")}/`
    : "";
  const writeMembers = new Set(
    [createMember, updateMember].filter((m): m is EnumMember => m !== undefined),
  );

  for (const model of allModels) {
    const versionDir = versionDirName ? `${versionDirName}/` : "";
    const dir = `${versionDir}${nsDir}`;

    const doPost = emitPost && (routeModels === undefined || routeModels.postModels.has(model));
    const doPatch = emitPatch && (routeModels === undefined || routeModels.patchModels.has(model));

    if (doPost) {
      const postProps = buildValidatorProperties(program, model, writeMembers, createMember, versionFilter);
      const postRefs = deriveReferencedValidators(postProps);
      const data: ValidatorTemplateData = {
        namespace,
        modelName: model.name,
        properties: postProps,
        referencedValidators: postRefs.length > 0 ? postRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(options.validatorsOutputDir, `${dir}${model.name}Validator${options.fileExtension}`),
        content: getValidatorPostTemplate()(data),
      });
    }

    if (doPatch) {
      const patchBodyTypeName = routeModels?.patchModels.get(model) ?? model.name;
      const patchProps = buildValidatorProperties(program, model, writeMembers, updateMember, versionFilter);
      const patchRefs = deriveReferencedValidators(patchProps);
      const data: ValidatorTemplateData = {
        namespace,
        modelName: model.name,
        patchBodyTypeName,
        properties: patchProps,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(options.validatorsOutputDir, `${dir}${model.name}PatchValidator${options.fileExtension}`),
        content: getValidatorPatchTemplate()(data),
      });
    }
  }
}

/** Emits version-aware POST and/or PATCH validators. */
async function emitVersionAwareValidatorModels(
  program: Program,
  allModels: Model[],
  routeModels: { postModels: Set<Model>; patchModels: Map<Model, string> } | undefined,
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
  const nsDir = options.validatorsOutputSubdirectory && namespace
    ? `${namespace.split(".").join("/")}/`
    : "";
  const writeMembers = new Set(
    [createMember, updateMember].filter((m): m is EnumMember => m !== undefined),
  );

  for (const model of allModels) {
    const doPost = emitPost && (routeModels === undefined || routeModels.postModels.has(model));
    const doPatch = emitPatch && (routeModels === undefined || routeModels.patchModels.has(model));

    if (doPost) {
      const { baseProperties, versionGroups } = buildVersionAwareValidatorProperties(
        program, model, writeMembers, createMember, allVersions,
      );
      const postRefs = deriveReferencedValidators(baseProperties, ...versionGroups.map((g) => g.properties));
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelName: model.name,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: postRefs.length > 0 ? postRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(options.validatorsOutputDir, `${nsDir}${model.name}Validator${options.fileExtension}`),
        content: getValidatorPostVersionAwareTemplate()(data),
      });
    }

    if (doPatch) {
      const patchBodyTypeName = routeModels?.patchModels.get(model) ?? model.name;
      const { baseProperties, versionGroups } = buildVersionAwareValidatorProperties(
        program, model, writeMembers, updateMember, allVersions,
      );
      const patchRefs = deriveReferencedValidators(baseProperties, ...versionGroups.map((g) => g.properties));
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelName: model.name,
        patchBodyTypeName,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(options.validatorsOutputDir, `${nsDir}${model.name}PatchValidator${options.fileExtension}`),
        content: getValidatorPatchVersionAwareTemplate()(data),
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
  routeModels: { postModels: Set<Model>; patchModels: Map<Model, string> } | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  isVersionAware: boolean,
  initOpts: EmitValidatorInitializerOptions = {},
): Promise<void> {
  const { versionDirName, versionNsSuffix } = initOpts;

  const registrations: ValidatorRegistration[] = [];
  for (const model of allModels) {
    if (emitPost && (routeModels === undefined || routeModels.postModels.has(model))) {
      registrations.push({ modelTypeName: model.name, validatorName: `${model.name}Validator` });
    }
    if (emitPatch && (routeModels === undefined || routeModels.patchModels.has(model))) {
      const patchBodyTypeName = routeModels?.patchModels.get(model) ?? model.name;
      registrations.push({ modelTypeName: patchBodyTypeName, validatorName: `${model.name}PatchValidator` });
    }
  }

  if (registrations.length === 0) return;

  let namespace: string | undefined = options.validatorsPathNamespace || undefined;
  if (versionNsSuffix) {
    namespace = namespace ? `${namespace}.${versionNsSuffix}` : versionNsSuffix;
  }

  const nsDir = options.validatorsOutputSubdirectory && namespace
    ? `${namespace.split(".").join("/")}/`
    : "";
  const versionDir = versionDirName ? `${versionDirName}/` : "";

  const data: InitializerTemplateData = { namespace, registrations, isVersionAware };
  await emitFile(program, {
    path: resolvePath(options.validatorsOutputDir, `${versionDir}${nsDir}ValidatorsInitializer${options.fileExtension}`),
    content: getValidatorInitializerTemplate()(data),
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
  const emitPost = options.validatorsTypes === "post" || options.validatorsTypes === "both";
  const emitPatch = options.validatorsTypes === "patch" || options.validatorsTypes === "both";

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
    options.validatorsVersionStrategy ?? (allVersions ? "version-aware" : "earliest");

  if (effectiveStrategy === "latest") {
    reportDiagnostic(program, {
      code: "version-strategy-breaking",
      target: NoTarget,
      format: {},
    });
  }

  if (effectiveStrategy === "per-version" && allVersions && allVersions.length > 0) {
    for (const version of allVersions) {
      const vf = makeValidatorVersionFilter(program, version.name);
      const versionNsSuffix = version.name.charAt(0).toUpperCase() + version.name.slice(1);
      const expandedRouteModels = routeModels
        ? { postModels: collectValidatorTransitiveDeps(program, routeModels.postModels, vf), patchModels: routeModels.patchModels }
        : undefined;
      await emitValidatorModels(
        program, allModels, expandedRouteModels, createMember, updateMember, options,
        emitPost, emitPatch,
        { versionFilter: vf, versionDirName: version.name, versionNsSuffix },
      );
      await emitValidatorsInitializer(
        program, allModels, expandedRouteModels, options, emitPost, emitPatch,
        /* isVersionAware */ false, { versionDirName: version.name, versionNsSuffix },
      );
    }
  } else if (effectiveStrategy === "version-aware" && allVersions && allVersions.length > 0) {
    const expandedRouteModels = routeModels
      ? { postModels: collectValidatorTransitiveDeps(program, routeModels.postModels), patchModels: routeModels.patchModels }
      : undefined;
    await emitVersionAwareValidatorModels(
      program, allModels, expandedRouteModels, createMember, updateMember, options,
      emitPost, emitPatch, allVersions,
    );
    await emitValidatorsInitializer(
      program, allModels, expandedRouteModels, options, emitPost, emitPatch,
      /* isVersionAware */ true,
    );
  } else {
    // "earliest" or "latest" (or no versioning)
    let versionFilter: ((prop: ModelProperty) => boolean) | undefined;
    if (allVersions && allVersions.length > 0) {
      const targetVersionName = effectiveStrategy === "latest"
        ? allVersions[allVersions.length - 1].name
        : allVersions[0].name;
      versionFilter = makeValidatorVersionFilter(program, targetVersionName);
    }
    const expandedRouteModels = routeModels
      ? { postModels: collectValidatorTransitiveDeps(program, routeModels.postModels, versionFilter), patchModels: routeModels.patchModels }
      : undefined;
    await emitValidatorModels(
      program, allModels, expandedRouteModels, createMember, updateMember, options,
      emitPost, emitPatch, { versionFilter },
    );
    await emitValidatorsInitializer(
      program, allModels, expandedRouteModels, options, emitPost, emitPatch,
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

  // When namespace-from-path is enabled, derive namespaces from the output
  // folder path and flatten files into the configured output dirs (no sub-folders).
  const ctrlNamespace = options.namespaceFromPath
    ? options.controllersPathNamespace
    : group.namespace;
  const svcNamespace = options.namespaceFromPath
    ? options.servicesPathNamespace
    : group.namespace;
  const folder = options.namespaceFromPath ? [] : group.folder;

  if (options.emitControllers) {
    const controllerFileName = `${controllerView.controllerName}${options.fileExtension}`;
    const ctrlUsings = buildControllerUsings(
      options,
      group.references,
      ctrlNamespace,
    );
    await emitFile(program, {
      path: resolvePath(options.controllersOutputDir, ...folder, controllerFileName),
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
      options,
      group.references,
      svcNamespace,
    );
    await emitFile(program, {
      path: resolvePath(options.servicesOutputDir, ...folder, serviceInterfaceFileName),
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
 * Writes the static `MergePatchValue<T>` helper class to the helpers output
 * directory. This is emitted automatically when any `MergePatchUpdate<T>` models
 * are generated, as they require this helper to function.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitMergePatchValue(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const mergePatchFileName = `MergePatchValue${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, mergePatchFileName),
    content: renderer.renderFile({
      fileName: mergePatchFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(HELPER_USINGS)),
      body: renderer.renderMergePatchValue(),
    }),
  });
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
 * and namespaces for all types referenced by the operations.
 *
 * @param options - Resolved emitter options (additional usings).
 * @param references - TypeSpec types referenced by controller operations.
 * @param ownNamespace - The C# namespace of the controller file being emitted.
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildControllerUsings(
  options: ResolvedOptions,
  references: Type[],
  ownNamespace: string,
): string[] {
  const usings = new Set<string>(CONTROLLER_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    for (const type of collectReferencedTypes(ref)) {
      const typespecNs = csharpNamespaceFor(type.namespace, options);
      // When namespace-from-path is enabled, apply the appropriate directory suffix
      // (modelsDirSuffix for models/enums that go in the models output dir)
      const ns =
        options.namespaceFromPath && options.modelsDirSuffix && typespecNs
          ? `${typespecNs}.${options.modelsDirSuffix}`
          : typespecNs;
      if (ns && ns !== ownNamespace) usings.add(ns);
    }
  }
  return sortUsings(usings);
}

/**
 * Builds the sorted list of `using` namespaces for a generated service interface file.
 *
 * Includes base service usings (System, System.Collections.Generic, System.Threading.Tasks),
 * any `additional-usings` from options, and namespaces for all types referenced by operations.
 *
 * @param options - Resolved emitter options (additional usings).
 * @param references - TypeSpec types referenced by service operations.
 * @param ownNamespace - The C# namespace of the service file being emitted.
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildServiceUsings(
  options: ResolvedOptions,
  references: Type[],
  ownNamespace: string,
): string[] {
  const usings = new Set<string>(SERVICE_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    for (const type of collectReferencedTypes(ref)) {
      const typespecNs = csharpNamespaceFor(type.namespace, options);
      // When namespace-from-path is enabled, apply the appropriate directory suffix
      // (modelsDirSuffix for models/enums that go in the models output dir)
      const ns =
        options.namespaceFromPath && options.modelsDirSuffix && typespecNs
          ? `${typespecNs}.${options.modelsDirSuffix}`
          : typespecNs;
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
    const name = (Object.entries(options.templates).find(([, p]) => p === path)?.[0] ??
      "unknown") as TemplateName;
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
function pathNamespace(rootNs: string | undefined, rawDir: string): string {
  const segments = rawDir
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(pascalCase);
  return rootNs ? [rootNs, ...segments].join(".") : segments.join(".");
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
    const children = [...ns.namespaces.values()].filter((n) => !isStdNamespace(n));
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
  // namespace tree so that controller, service, and helper files automatically
  // receive a properly-qualified namespace (e.g. "MyApp.Controllers" rather
  // than just "Controllers").
  const effectiveRootNs = rootNs ?? inferRootNamespace(context.program);
  // Determine if we should use namespace-from-path mode
  const useNamespaceFromPath = raw["namespace-from-path"] ?? true;
  // When namespace-from-path is enabled, always compute the dir suffixes
  // to include output directories in namespaces. Otherwise, leave them empty.
  const modelsDirSuffix = useNamespaceFromPath ? pathNamespace(undefined, modelsDir) : "";
  const interfacesDirSuffix = useNamespaceFromPath ? pathNamespace(undefined, interfacesDir) : "";
  return {
    rootNamespace: rootNs,
    namespaceMap,
    fileExtension: raw["file-extension"] ?? ".g.cs",
    modelsOutputDir: resolvePath(baseDir, modelsDir),
    emitInterfaces: raw["emit-interfaces"] ?? true,
    interfacesOutputDir: resolvePath(baseDir, interfacesDir),
    emitControllers: raw["emit-controllers"] ?? true,
    controllersOutputDir: resolvePath(baseDir, controllersDir),
    emitServices: raw["emit-services"] ?? true,
    servicesOutputDir: resolvePath(baseDir, servicesDir),
    emitHelpers: raw["emit-helpers"] ?? false,
    helpersOutputDir: resolvePath(baseDir, helpersDir),
    routePrefix: raw["route-prefix"] ?? "api",
    namespaceFromPath: useNamespaceFromPath,
    modelsDirSuffix,
    interfacesDirSuffix,
    controllersPathNamespace: pathNamespace(effectiveRootNs, controllersDir),
    servicesPathNamespace: pathNamespace(effectiveRootNs, servicesDir),
    helpersNamespace: pathNamespace(effectiveRootNs, helpersDir),
    additionalUsings: raw["additional-usings"] ?? [],
    nullableProperties: raw["nullable-properties"] ?? true,
    abstractSuffix: raw["abstract-suffix"] ?? "Base",
    templates: resolveTemplatePaths(raw.templates),
    emitValidators: raw["emit-validators"] ?? false,
    validatorsPathNamespace: pathNamespace(effectiveRootNs, validatorsDir),
    validatorsOutputDir: resolvePath(baseDir, validatorsDir),
    validatorsTypes: raw["validators"] ?? "both",
    validatorsVersionStrategy: raw["validators-version-strategy"],
    validatorsOutputSubdirectory: raw["validators-output-subdirectory"] ?? false,
  };
}

/**
 * Converts the raw `templates` option values (relative paths as the user types
 * them) to absolute paths that the renderer can use directly.
 *
 * @param templates - Raw template override map from user config.
 * @returns Template override map with all paths made absolute.
 */
function resolveTemplatePaths(templates: EmitterOptions["templates"]): TemplateOverrides {
  if (!templates) return {};
  const out: TemplateOverrides = {};
  const keys: (keyof TemplateOverrides)[] = [
    "file",
    "class",
    "interface",
    "enum",
    "controller",
    "service-interface",
    "merge-patch-value",
    "enum-member-converter",
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
 * Falls back to `root-namespace` (if set) or `"Models"` for top-level types.
 *
 * @param ns - TypeSpec namespace node, or `undefined`.
 * @param options - Resolved options carrying the namespace map and root.
 * @returns Dot-separated C# namespace string.
 */
function csharpNamespaceFor(ns: Namespace | undefined, options: ResolvedOptions): string {
  const fullNs = namespaceFullName(ns);
  if (!fullNs) return options.rootNamespace ?? DEFAULT_NAMESPACE;
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
function folderSegments(rootNs: string | undefined, csharpNs: string): string[] {
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
  /** The dir-suffix currently applied to the emitting file's namespace. */
  dirSuffix = "",
  usesMergePatchValue = false,
): string[] {
  const usings = new Set<string>(SYSTEM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    for (const type of collectReferencedTypes(ref)) {
      const typespecNs = csharpNamespaceFor(type.namespace, options);
      // When a dir-suffix has been applied to the emitting file's namespace,
      // the same suffix must be applied to referenced types so that
      // using-directives point at the correct C# namespace.
      const ns =
        options.namespaceFromPath && dirSuffix && typespecNs
          ? `${typespecNs}.${dirSuffix}`
          : typespecNs;
      if (ns && ns !== ownNamespace) usings.add(ns);
    }
  }
  if (usesMergePatchValue && options.helpersNamespace !== ownNamespace) {
    usings.add(options.helpersNamespace);
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
function collectEnumUsings(ownNamespace: string, options: ResolvedOptions): string[] {
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
  isMergePatchModel: boolean,
): ClassView {
  const className = pascalCase(model.name);
  return {
    doc: docFor(program, model),
    className,
    interfaceName: `I${className}`,
    baseClass: model.baseModel ? typeReference(model.baseModel) : undefined,
    properties: buildPropertyViews(program, model, options, isMergePatchModel),
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
  isMergePatchModel: boolean,
): InterfaceView {
  return {
    doc: docFor(program, model),
    interfaceName: `I${pascalCase(model.name)}`,
    baseInterface: model.baseModel ? `I${pascalCase(model.baseModel.name)}` : undefined,
    properties: buildPropertyViews(program, model, options, isMergePatchModel),
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
        memberValue: typeof member.value === "string" ? member.value : member.name,
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
  isMergePatchModel: boolean,
): PropertyView[] {
  return [...model.properties.values()].map((prop) => {
    const type = propertyTypeName(
      program,
      model,
      prop,
      options,
      isMergePatchModel,
    );
    return {
      doc: docFor(program, prop),
      type,
      name: pascalCase(prop.name),
      jsonName: camelCase(prop.name),
      nullable: type.endsWith("?"),
      initializer:
        isMergePatchModel && type.startsWith("MergePatchValue<")
          ? `${type}.Absent`
          : prop.defaultValue !== undefined
            ? defaultValueInitializer(prop.defaultValue)
            : undefined,
    };
  });
}

/**
 * Retrieves and pre-renders the `@doc` annotation for a model or property.
 *
 * @param program - The compiled TypeSpec program.
 * @param target - The annotated model or model property.
 * @returns Pre-rendered XML summary string, or `undefined` if no doc is present.
 */
function docFor(program: Program, target: Model | ModelProperty): string | undefined {
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
  isMergePatchModel: boolean,
): string {
  const propFormat = getFormat(program, prop);
  const scalarFormat =
    prop.type.kind === "Scalar" ? getFormat(program, prop.type) : undefined;
  const format = propFormat ?? scalarFormat;
  let type: string;
  if (format && FORMAT_MAP[format.toLowerCase()]) {
    type = FORMAT_MAP[format.toLowerCase()];
  } else {
    const inferredEnumType = inferredEnumTypeNameForProperty(
      model,
      prop,
      isMergePatchModel,
    );
    type = inferredEnumType ?? typeReference(prop.type);
  }
  const nullable = prop.optional || options.nullableProperties;
  const nullableType = nullable && !type.endsWith("?") ? `${type}?` : type;
  if (isMergePatchModel) {
    return `MergePatchValue<${nullableType}>`;
  }
  return nullableType;
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
  isMergePatchModel: boolean,
): string | undefined {
  if (!getStringLiteralUnionValues(prop.type)) return undefined;

  const modelStem = isMergePatchModel
    ? model.name.replace(/MergePatchUpdate$/i, "")
    : model.name;
  return `${pascalCase(modelStem)}${pascalCase(prop.name)}`;
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
  const explicitEnumKeys = new Set(
    explicitEnums.map((en) => {
      const typespecNs = csharpNamespaceFor(en.namespace, options);
      const ns =
        options.namespaceFromPath && options.modelsDirSuffix
          ? `${typespecNs}.${options.modelsDirSuffix}`
          : typespecNs;
      return `${ns}.${pascalCase(en.name)}`;
    }),
  );

  for (const model of models) {
    const isMergePatchModel = isMergePatchUpdateModel(model);
    const typespecNs = csharpNamespaceFor(model.namespace, options);
    const ns =
      options.namespaceFromPath && options.modelsDirSuffix
        ? `${typespecNs}.${options.modelsDirSuffix}`
        : typespecNs;
    const folder =
      options.namespaceFromPath && options.modelsDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecNs);

    for (const prop of model.properties.values()) {
      const values = getStringLiteralUnionValues(prop.type);
      if (!values) continue;

      const name = inferredEnumTypeNameForProperty(model, prop, isMergePatchModel);
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
 * Returns `true` when a model's name ends with `"MergePatchUpdate"` (case-insensitive),
 * matching the `{ResourceName}MergePatchUpdate` convention used by `@typespec/http`.
 *
 * Merge-patch models have every property wrapped in `MergePatchValue<T>` so that
 * RFC 7396 semantics — distinguishing an absent field from an explicit `null` —
 * are preserved end-to-end.
 *
 * @param model - The TypeSpec model to check.
 * @returns `true` if the model represents a merge-patch update payload.
 */
function isMergePatchUpdateModel(model: Model): boolean {
  return /MergePatchUpdate$/i.test(model.name);
}

/**
 * Recursively resolves the C# type string for any TypeSpec {@link Type} node,
 * without applying nullability.
 *
 * @param type - The TypeSpec type node to resolve.
 * @returns C# type string (non-nullable).
 */
function typeReference(type: Type): string {
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
        return `IList<${typeReference(type.indexer.value)}>`;
      }
      if (isRecordModelType(type)) {
        return `IDictionary<string, ${typeReference(type.indexer.value)}>`;
      }
      return pascalCase(type.name || "object");
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
        const ref = typeReference(nonNull[0].type);
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

