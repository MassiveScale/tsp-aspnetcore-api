/**
 * @module validators
 *
 * Emits FluentValidation-style `AbstractValidator<T>` classes for POST and
 * PATCH request bodies (ported from tsp-fluent-validators), plus the
 * `ValidatorsInitializer` that registers them for DI.
 *
 * The main export is {@link emitValidators}, called by the emitter when
 * `emit-validators` is `true`.
 */

import {
  type Enum,
  type EnumMember,
  Model,
  ModelProperty,
  Program,
  type Scalar,
  Type,
  type Union,
  emitFile,
  getDiscriminatedUnionFromInheritance,
  getDiscriminator,
  getFormat,
  getLifecycleVisibilityEnum,
  getMaxLength,
  getMaxValue,
  getMinLength,
  getMinValue,
  getPattern,
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
import { computeModelFqName, ResolvedOptions } from "./emitter.js";
import { reportDiagnostic } from "./lib.js";
import { pascalCase } from "./utils.js";

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

/** A derived type validator for polymorphic dispatch via SetInheritanceValidator. */
interface DerivedTypeValidator {
  /** Simple C# type name of the derived type (e.g. "Cat"). */
  typeName: string;
  /** Fully-qualified C# type name (e.g. "MyApp.Models.Cat"). */
  qualifiedTypeName: string;
  /** Constructor parameter name (e.g. "catValidator"). */
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
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  properties: PropertyData[];
  referencedValidators?: ReferencedValidator[];
  /** Derived type validators for polymorphic dispatch (SetInheritanceValidator). */
  derivedTypeValidators?: DerivedTypeValidator[];
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
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  allVersions: string[];
  defaultVersion: string;
  baseProperties: PropertyData[];
  versionGroups: VersionGroup[];
  referencedValidators?: ReferencedValidator[];
  /** Derived type validators for polymorphic dispatch (SetInheritanceValidator). */
  derivedTypeValidators?: DerivedTypeValidator[];
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
  options: ResolvedOptions,
  isReadOnly = false,
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
    ? `${options.modelsNamespace}.${pascalCase((prop.type as Enum).name)}`
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
    nullable: isNullableForValidator(program, prop, options.nullableProperties),
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
  options: ResolvedOptions,
  visibilityMember?: EnumMember,
  versionFilter?: (prop: ModelProperty) => boolean,
): PropertyData[] {
  const result: PropertyData[] = [];
  const discriminatorPropertyName = discriminatorPropertyNameInHierarchy(
    program,
    model,
  );
  for (const [, prop] of model.properties) {
    if (prop.name === discriminatorPropertyName) continue;

    const isWritable =
      writeMembers.size === 0 ||
      isVisible(program, prop, { any: writeMembers });

    if (!isWritable) {
      // Include read-only property so the validator can reject it.
      result.push(buildSinglePropertyData(program, prop, options, true));
      continue;
    }
    if (
      visibilityMember &&
      !isVisible(program, prop, { any: new Set([visibilityMember]) })
    ) {
      continue;
    }
    if (versionFilter && !versionFilter(prop)) continue;
    result.push(buildSinglePropertyData(program, prop, options, false));
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
  options: ResolvedOptions,
): { baseProperties: PropertyData[]; versionGroups: VersionGroup[] } {
  const baseProperties: PropertyData[] = [];
  const groupMap = new Map<string, PropertyData[]>();
  const discriminatorPropertyName = discriminatorPropertyNameInHierarchy(
    program,
    model,
  );

  for (const [, prop] of model.properties) {
    if (prop.name === discriminatorPropertyName) continue;

    const isWritable =
      writeMembers.size === 0 ||
      isVisible(program, prop, { any: writeMembers });

    if (!isWritable) {
      baseProperties.push(
        buildSinglePropertyData(program, prop, options, true),
      );
      continue;
    }
    if (
      visibilityMember &&
      !isVisible(program, prop, { any: new Set([visibilityMember]) })
    ) {
      continue;
    }
    const propData = buildSinglePropertyData(program, prop, options, false);
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
 * Builds the {@link DerivedTypeValidator} array for a model that carries
 * `@discriminator`. Uses {@link getDiscriminatedUnionFromInheritance} to find
 * all concrete derived types and returns them sorted by type name.
 *
 * Returns `undefined` when the model has no discriminator.
 */
function buildDerivedTypeValidators(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): DerivedTypeValidator[] | undefined {
  const discriminator = getDiscriminator(program, model);
  if (!discriminator) return undefined;

  const [union] = getDiscriminatedUnionFromInheritance(model, discriminator);
  const derived: DerivedTypeValidator[] = [];
  for (const [, derivedModel] of union.variants) {
    const typeName =
      getServerName(program, derivedModel) ?? pascalCase(derivedModel.name);
    const qualifiedTypeName = computeModelFqName(
      program,
      derivedModel,
      options,
    );
    const paramName =
      typeName.charAt(0).toLowerCase() + typeName.slice(1) + "Validator";
    derived.push({ typeName, qualifiedTypeName, paramName });
  }
  derived.sort((a, b) => a.typeName.localeCompare(b.typeName));
  return derived.length > 0 ? derived : undefined;
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

/** Returns all models that transitively derive from `model` (children, grandchildren, ...). */
function getAllDescendants(allModels: Model[], model: Model): Model[] {
  const result: Model[] = [];
  const queue = [model];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of allModels) {
      if (candidate.baseModel === current) {
        result.push(candidate);
        queue.push(candidate);
      }
    }
  }
  return result;
}

/** Adds the given model and all its transitive descendants to the target set. */
function addModelWithDescendants(
  allModels: Model[],
  model: Model,
  target: Set<Model>,
): void {
  target.add(model);
  for (const descendant of getAllDescendants(allModels, model)) {
    target.add(descendant);
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
export function collectValidatorModelsFromRoutes(
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
          // Also register transitive descendants, deriving their patch body type name.
          for (const candidate of getAllDescendants(allModels, sourceModel)) {
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
  return { postModels, patchModels };
}

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
  /** Fully-qualified type for DI registration in `ValidatorsInitializer`. Always equal to `qualifiedPatchBodyTypeName`. */
  fullyQualifiedTypeName: string;
} {
  const isMergePatchBody = rawBodyTypeName.startsWith("MergePatch<");
  if (!isMergePatchBody) {
    return {
      patchBodyTypeName: rawBodyTypeName,
      qualifiedPatchBodyTypeName: qualifiedModelName,
      fullyQualifiedTypeName: qualifiedModelName,
    };
  }
  if (options.mergePatchStyle === "typed") {
    const typedName = `${modelName}MergePatchUpdate`;
    const fullyQualified = `${options.modelsNamespace}.${modelName}MergePatchUpdate`;
    return {
      patchBodyTypeName: typedName,
      qualifiedPatchBodyTypeName: fullyQualified,
      fullyQualifiedTypeName: fullyQualified,
    };
  }
  // Generic style
  const fullyQualified = `${options.helpersNamespace}.MergePatch<${qualifiedModelName}>`;
  return {
    patchBodyTypeName: rawBodyTypeName,
    qualifiedPatchBodyTypeName: fullyQualified,
    fullyQualifiedTypeName: fullyQualified,
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
        options,
        createMember,
        versionFilter,
      );
      const postRefs = deriveReferencedValidators(program, options, postProps);
      const derivedTypeValidators = buildDerivedTypeValidators(
        program,
        model,
        options,
      );
      const data: ValidatorTemplateData = {
        namespace,
        modelName,
        qualifiedModelName,
        properties: postProps,
        referencedValidators: postRefs.length > 0 ? postRefs : undefined,
        derivedTypeValidators,
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
        options,
        updateMember,
        versionFilter,
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
          options,
        );
      const postRefs = deriveReferencedValidators(
        program,
        options,
        baseProperties,
        ...versionGroups.map((g) => g.properties),
      );
      const derivedTypeValidators = buildDerivedTypeValidators(
        program,
        model,
        options,
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
        derivedTypeValidators,
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
      const { patchBodyTypeName, qualifiedPatchBodyTypeName } =
        resolvePatchBodyInfo(
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
          options,
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
 * Finds the discriminator property name governing `model`, searching `model`
 * itself and then its base-model chain.
 */
function discriminatorPropertyNameInHierarchy(
  program: Program,
  model: Model,
): string | undefined {
  for (
    let current: Model | undefined = model;
    current;
    current = current.baseModel
  ) {
    const discriminator = getDiscriminator(program, current);
    if (discriminator) return discriminator.propertyName;
  }
  return undefined;
}

/**
 * Entry point for validator emission. Called from `$onEmit` when
 * `emit-validators` is `true`.
 */
export async function emitValidators(
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
