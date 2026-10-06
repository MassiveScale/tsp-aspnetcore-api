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
import { computeModelTypeName, ResolvedOptions } from "./emitter.js";
import { reportDiagnostic } from "./lib.js";
import { csharpModelName, qualifyTypeName } from "./naming.js";
import { classProperties } from "./payloads.js";
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
  Handlebars.TemplateDelegate | undefined;
let _compiledValidatorPatchVersionAwareTemplate:
  Handlebars.TemplateDelegate | undefined;
let _compiledValidatorInitializerTemplate:
  Handlebars.TemplateDelegate | undefined;

/** Name of the shared partial that renders nested MergePatch property rules. */
const MERGE_PATCH_NESTED_PARTIAL = "mergePatchNestedRules";

/**
 * Compiles a validator template, first registering the partials that the
 * built-in templates share so custom templates can include them too.
 */
function loadValidatorTemplate(path: string): Handlebars.TemplateDelegate {
  if (!Handlebars.partials[MERGE_PATCH_NESTED_PARTIAL]) {
    Handlebars.registerPartial(
      MERGE_PATCH_NESTED_PARTIAL,
      readFileSync(
        resolve(TEMPLATES_DIR, "validator-merge-patch-nested.hbs"),
        "utf-8",
      ),
    );
  }
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
  /**
   * True for a required non-string property whose C# type can hold `null`:
   * POST validators emit `NotNull()`. (A non-nullable value type such as `int`
   * with `nullable-properties: false` reads an absent field as `0`, so it
   * cannot be checked.)
   */
  notNull: boolean;
  /**
   * True for every required property (any type) whose declared type does not
   * include `null`: MergePatch PATCH validators reject an explicit `null`,
   * which would remove the value. `notNull` is likewise suppressed for
   * explicitly nullable types such as `string | null`.
   */
  rejectNull: boolean;
  /** True when the property is read-only (not writable for the target lifecycle). */
  isReadOnly?: boolean;
  /**
   * True when the property is writable in another lifecycle phase but not
   * this one: create-only (immutable) in PATCH, or update-only in POST. It is
   * rejected like a read-only property, with a phase-specific message.
   */
  isImmutable?: boolean;
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
  referencedQualifiedModelName?: string;
  referencedParamName?: string;
  isCollectionReference?: boolean;
  mergePatchValidatorTypeName?: string;
  mergePatchValidatorParamName?: string;
  mergePatchFactoryTypeName?: string;
}

/** Validator for a referenced child model (injected as constructor parameter). */
interface ReferencedValidator {
  modelName: string;
  qualifiedModelName: string;
  qualifiedValidatorTypeName: string;
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
  modelsNamespace: string;
  helpersNamespace: string;
  fullyQualifiedTypes: boolean;
  useHelpersNamespace: boolean;
  modelName: string;
  /** Fully-qualified C# type name of the validated model (e.g. `MyApp.Models.Pet`). */
  qualifiedModelName: string;
  /** C# type name of the validated PATCH body (e.g. `MergePatch<Pet>`). Only set for patch validators. */
  patchBodyTypeName?: string;
  /** Fully-qualified C# type name of the PATCH body (e.g. `MergePatch<MyApp.Models.Pet>`). Only set for patch validators. */
  qualifiedPatchBodyTypeName?: string;
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  /** C# class name of the PATCH validator (e.g. `PetPatchValidator`). Only set for patch validators. */
  validatorName?: string;
  /**
   * True when a MergePatch validator deserializes nested values and so takes the
   * application's `IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>` in its constructor.
   */
  usesJsonOptions?: boolean;
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
  modelsNamespace: string;
  helpersNamespace: string;
  fullyQualifiedTypes: boolean;
  useHelpersNamespace: boolean;
  modelName: string;
  /** Fully-qualified C# type name of the validated model (e.g. `MyApp.Models.Pet`). */
  qualifiedModelName: string;
  /** C# type name of the validated PATCH body (e.g. `MergePatch<Pet>`). Only set for patch validators. */
  patchBodyTypeName?: string;
  /** Fully-qualified C# type name of the PATCH body (e.g. `MergePatch<MyApp.Models.Pet>`). Only set for patch validators. */
  qualifiedPatchBodyTypeName?: string;
  /** True when the PATCH body is a `MergePatch<T>` — suppresses property-accessor-based rules that won't compile. */
  isMergePatchBody?: boolean;
  /** C# class name of the PATCH validator (e.g. `PetPatchValidator`). Only set for patch validators. */
  validatorName?: string;
  /**
   * True when a MergePatch validator deserializes nested values and so takes the
   * application's `IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>` in its constructor.
   */
  usesJsonOptions?: boolean;
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
  modelsNamespace: string;
  helpersNamespace: string;
  fullyQualifiedTypes: boolean;
  useHelpersNamespace: boolean;
  registrations: ValidatorRegistration[];
  isVersionAware: boolean;
}

interface ValidatorRouteModels {
  postModels: Set<Model>;
  /** Raw PATCH body type names per model; see {@link collectValidatorModelsFromRoutes}. */
  patchModels: Map<Model, Set<string>>;
  nestedPostModels: Set<Model>;
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

/**
 * Returns `true` when the declared type explicitly allows `null`
 * (`string | null`, `int32 | null`, `Widget | null`, `"a" | "b" | null`).
 * Such a property may be required, meaning it must be present, but `null` is
 * still a valid value, so no non-null rule applies.
 */
function typeAllowsNull(type: Type): boolean {
  if (type.kind !== "Union") return false;
  for (const [, variant] of (type as Union).variants) {
    if (variant.type.kind === "Intrinsic" && variant.type.name === "null") {
      return true;
    }
  }
  return false;
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
  const nonNullType = getNonNullType(type);
  if (nonNullType?.kind !== "Model") return undefined;
  const m = nonNullType as Model;
  if (m.indexer !== undefined) {
    const elemType = m.indexer.value
      ? getNonNullType(m.indexer.value)
      : undefined;
    if (!elemType || elemType.kind !== "Model") return undefined;
    const elemModel = elemType as Model;
    if (shouldSkipValidatorModel(elemModel)) return undefined;
    return { model: elemModel, isCollection: true };
  }
  if (shouldSkipValidatorModel(m)) return undefined;
  return { model: m, isCollection: false };
}

/** Unwraps a nullable union containing exactly one non-null type. */
function getNonNullType(type: Type): Type | undefined {
  if (type.kind !== "Union") return type;
  const nonNullTypes = [...(type as Union).variants.values()]
    .map((variant) => variant.type)
    .filter(
      (variant) => !(variant.kind === "Intrinsic" && variant.name === "null"),
    );
  return nonNullTypes.length === 1 ? nonNullTypes[0] : undefined;
}

/**
 * Extracts all constraint data for a single model property.
 *
 * @param isReadOnly - The property must be rejected when supplied.
 * @param isImmutable - The rejection is because the property belongs to a
 *   different lifecycle phase (see {@link PropertyData.isImmutable}).
 */
function buildSinglePropertyData(
  program: Program,
  prop: ModelProperty,
  options: ResolvedOptions,
  isReadOnly = false,
  isImmutable = false,
): PropertyData {
  const hasDefault = prop.defaultValue !== undefined;
  const nullable = isNullableForValidator(
    program,
    prop,
    options.nullableProperties,
  );
  const isRequired = !isReadOnly && !prop.optional && !hasDefault;
  const notEmpty =
    isRequired &&
    (isStringScalar(prop.type) || isStringLiteralUnion(prop.type));
  const rejectNull = isRequired && !typeAllowsNull(prop.type);
  const notNull = rejectNull && !notEmpty && nullable;
  const minLength =
    getMinLength(program, prop) ?? getMinLength(program, prop.type);
  const maxLength =
    getMaxLength(program, prop) ?? getMaxLength(program, prop.type);
  const pattern = getPattern(program, prop) ?? getPattern(program, prop.type);
  const format = getFormat(program, prop) ?? getFormat(program, prop.type);
  const emailAddress = format === "email";

  const isInEnum = prop.type.kind === "Enum";
  const enumTypeName = isInEnum
    ? qualifyTypeName(
        options.modelsNamespace,
        pascalCase((prop.type as Enum).name),
        options,
      )
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
    ? csharpModelName(program, modelRef.model)
    : undefined;
  const referencedParamName = referencedModelName
    ? referencedModelName.charAt(0).toLowerCase() +
      referencedModelName.slice(1) +
      "Validator"
    : undefined;
  const isCollectionReference = modelRef?.isCollection;
  const referencedQualifiedModelName = modelRef
    ? computeModelTypeName(program, modelRef.model, options)
    : undefined;
  const mergePatchValidator = modelRef
    ? isCollectionReference
      ? {
          typeName: referencedQualifiedModelName!,
          paramName: `${referencedModelName!.charAt(0).toLowerCase()}${referencedModelName!.slice(1)}Validator`,
          factoryTypeName: undefined,
        }
      : (() => {
          const bodyInfo = resolvePatchBodyInfo(
            `MergePatch<${referencedModelName}>`,
            referencedModelName!,
            referencedQualifiedModelName!,
            options,
          );
          return {
            typeName: bodyInfo.qualifiedPatchBodyTypeName,
            paramName: `${referencedModelName!.charAt(0).toLowerCase()}${referencedModelName!.slice(1)}PatchValidator`,
            factoryTypeName: bodyInfo.qualifiedPatchBodyTypeName,
          };
        })()
    : undefined;

  const hasRules =
    isReadOnly ||
    isRequired ||
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
    notNull,
    rejectNull,
    isReadOnly: isReadOnly || undefined,
    isImmutable: (isReadOnly && isImmutable) || undefined,
    nullable,
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
    referencedQualifiedModelName: isReadOnly
      ? undefined
      : referencedQualifiedModelName,
    referencedParamName: isReadOnly ? undefined : referencedParamName,
    isCollectionReference: isReadOnly ? undefined : isCollectionReference,
    mergePatchValidatorTypeName: isReadOnly
      ? undefined
      : mergePatchValidator?.typeName,
    mergePatchValidatorParamName: isReadOnly
      ? undefined
      : mergePatchValidator?.paramName,
    mergePatchFactoryTypeName: isReadOnly
      ? undefined
      : mergePatchValidator?.factoryTypeName,
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
  for (const prop of classProperties(program, model)) {
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
      // Writable in the other lifecycle phase only (e.g. create-only in a
      // PATCH): reject it rather than silently accepting it.
      result.push(buildSinglePropertyData(program, prop, options, true, true));
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

  for (const prop of classProperties(program, model)) {
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
      baseProperties.push(
        buildSinglePropertyData(program, prop, options, true, true),
      );
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
          ? computeModelTypeName(program, p.referencedModel, options)
          : p.referencedModelName;
        result.push({
          modelName: p.referencedModelName,
          qualifiedModelName,
          qualifiedValidatorTypeName: qualifiedModelName,
          paramName: p.referencedParamName!,
        });
      }
    }
  }
  return result;
}

/** Builds injected validator references for raw MergePatch nested properties. */
function deriveMergePatchReferencedValidators(
  program: Program,
  options: ResolvedOptions,
  ...propertyGroups: PropertyData[][]
): ReferencedValidator[] {
  const seen = new Set<string>();
  const result: ReferencedValidator[] = [];
  for (const props of propertyGroups) {
    for (const prop of props) {
      if (
        !prop.referencedModelName ||
        !prop.referencedModel ||
        !prop.mergePatchValidatorTypeName ||
        !prop.mergePatchValidatorParamName ||
        seen.has(prop.mergePatchValidatorTypeName)
      ) {
        continue;
      }
      seen.add(prop.mergePatchValidatorTypeName);
      result.push({
        modelName: prop.referencedModelName,
        qualifiedModelName: computeModelTypeName(
          program,
          prop.referencedModel,
          options,
        ),
        qualifiedValidatorTypeName: prop.mergePatchValidatorTypeName,
        paramName: prop.mergePatchValidatorParamName,
      });
    }
  }
  return result;
}

/**
 * Builds the {@link DerivedTypeValidator} array for a model that carries
 * `@discriminator`. Uses {@link getDiscriminatedUnionFromInheritance} to find
 * all concrete derived types and returns them sorted by type name.
 *
 * Derived models without a class (and so without a validator) are left out,
 * so the constructor never asks for a validator that is never registered.
 *
 * Returns `undefined` when the model has no discriminator.
 */
function buildDerivedTypeValidators(
  program: Program,
  model: Model,
  options: ResolvedOptions,
  validatedModels: readonly Model[],
): DerivedTypeValidator[] | undefined {
  const discriminator = getDiscriminator(program, model);
  if (!discriminator) return undefined;

  const [union] = getDiscriminatedUnionFromInheritance(model, discriminator);
  const derived: DerivedTypeValidator[] = [];
  for (const [, derivedModel] of union.variants) {
    if (!validatedModels.includes(derivedModel)) continue;
    const typeName = csharpModelName(program, derivedModel);
    const qualifiedTypeName = computeModelTypeName(
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
 *
 * Models derived from a reachable model are included too: a discriminated base
 * validator injects one validator per derived type, and a derived type can
 * declare references of its own.
 */
function collectValidatorTransitiveDeps(
  program: Program,
  allModels: Model[],
  initialModels: Set<Model>,
  versionFilter?: (prop: ModelProperty) => boolean,
): Set<Model> {
  const all = new Set<Model>();
  const queue: Model[] = [];
  const add = (model: Model) => {
    for (const candidate of [model, ...getAllDescendants(allModels, model)]) {
      if (all.has(candidate)) continue;
      all.add(candidate);
      queue.push(candidate);
    }
  };
  initialModels.forEach(add);
  while (queue.length > 0) {
    const model = queue.shift()!;
    for (const prop of classProperties(program, model)) {
      if (versionFilter && !versionFilter(prop)) continue;
      const ref = getValidatorModelReference(prop.type);
      if (ref) add(ref.model);
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
 * For PATCH, `patchModels` maps each source model to the raw C# names of every
 * PATCH body type it is validated as: `"MergePatch<Pet>"` for a MergePatch body
 * (or a model nested inside one), `"Pet"` for a plain PATCH body. A model can
 * need both, for example when it has its own plain PATCH route and is also
 * nested inside another route's MergePatch body. Use {@link patchValidatorsFor}
 * to read the entries in a stable order with their validator class names.
 *
 * Nested references are followed from the body model and from every model
 * derived from it, because a derived type's validator also validates the
 * properties only that derived type declares.
 */
export function collectValidatorModelsFromRoutes(
  program: Program,
  allModels: Model[],
): ValidatorRouteModels | undefined {
  const [services] = getAllHttpServices(program);
  const hasAnyOperations = services.some((s) => s.operations.length > 0);
  if (!hasAnyOperations) return undefined;

  const postModels = new Set<Model>();
  const patchModels = new Map<Model, Set<string>>();
  const nestedPostModels = new Set<Model>();

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
        continue;
      }

      const isMergePatchBody = isMergePatch(program, bodyModel);
      const sourceModel = isMergePatchBody
        ? getMergePatchSource(program, bodyModel)
        : bodyModel;
      if (!sourceModel) continue;

      const routeModels = [
        sourceModel,
        ...getAllDescendants(allModels, sourceModel),
      ];
      for (const model of routeModels) {
        addPatchBody(program, patchModels, model, isMergePatchBody);
      }

      const pending = [...routeModels];
      const visited = new Set<Model>();
      while (pending.length > 0) {
        const current = pending.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const prop of classProperties(program, current)) {
          const reference = getValidatorModelReference(prop.type);
          if (!reference) continue;
          if (!isMergePatchBody || reference.isCollection) {
            nestedPostModels.add(reference.model);
            continue;
          }
          addPatchBody(program, patchModels, reference.model, true);
          pending.push(reference.model);
        }
      }
    }
  }
  return { postModels, patchModels, nestedPostModels };
}

/** Records that `model` is validated as a MergePatch body or as a plain PATCH body. */
function addPatchBody(
  program: Program,
  patchModels: Map<Model, Set<string>>,
  model: Model,
  isMergePatchBody: boolean,
): void {
  const modelName = csharpModelName(program, model);
  const bodies = patchModels.get(model) ?? new Set<string>();
  bodies.add(isMergePatchBody ? `MergePatch<${modelName}>` : modelName);
  patchModels.set(model, bodies);
}

/** One PATCH validator to emit for a model. */
interface PatchValidatorEntry {
  /** Raw body type name, e.g. `"MergePatch<Pet>"` or `"Pet"`. */
  rawBodyTypeName: string;
  /** C# validator class name, e.g. `"PetPatchValidator"`. */
  validatorName: string;
}

/**
 * Lists the PATCH validators to emit for `model`, plain body first.
 *
 * A model normally gets a single `{Model}PatchValidator`. When it is validated
 * both as a plain PATCH body and as a MergePatch body, the plain one keeps
 * `{Model}PatchValidator` and the MergePatch one is named
 * `{Model}MergePatchValidator`, so both classes can live side by side.
 *
 * Returns an empty list when the model is not a PATCH body. When no HTTP
 * operations exist (`routeModels` is `undefined`), every model gets one plain
 * PATCH validator.
 */
function patchValidatorsFor(
  program: Program,
  model: Model,
  routeModels: ValidatorRouteModels | undefined,
): PatchValidatorEntry[] {
  const modelName = csharpModelName(program, model);
  const bodies = routeModels
    ? routeModels.patchModels.get(model)
    : new Set([modelName]);
  if (!bodies || bodies.size === 0) return [];

  const hasPlainBody = bodies.has(modelName);
  return [...bodies]
    .sort((a, b) => Number(isMergePatchName(a)) - Number(isMergePatchName(b)))
    .map((rawBodyTypeName) => ({
      rawBodyTypeName,
      validatorName:
        hasPlainBody && isMergePatchName(rawBodyTypeName)
          ? `${modelName}MergePatchValidator`
          : `${modelName}PatchValidator`,
    }));
}

function isMergePatchName(rawBodyTypeName: string): boolean {
  return rawBodyTypeName.startsWith("MergePatch<");
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
    const fullyQualified = qualifyTypeName(
      options.modelsNamespace,
      typedName,
      options,
    );
    return {
      patchBodyTypeName: typedName,
      qualifiedPatchBodyTypeName: fullyQualified,
      fullyQualifiedTypeName: fullyQualified,
    };
  }
  const fullyQualified = `${qualifyTypeName(options.helpersNamespace, "MergePatch", options)}<${qualifiedModelName}>`;
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
  routeModels: ValidatorRouteModels | undefined,
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
      (emitPost &&
        (routeModels === undefined || routeModels.postModels.has(model))) ||
      (emitPatch && routeModels?.nestedPostModels.has(model));
    const patchValidators = emitPatch
      ? patchValidatorsFor(program, model, routeModels)
      : [];

    const qualifiedModelName = computeModelTypeName(program, model, options);
    const modelName = csharpModelName(program, model);

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
        allModels,
      );
      const data: ValidatorTemplateData = {
        namespace,
        modelsNamespace: options.modelsNamespace,
        helpersNamespace: options.helpersNamespace,
        fullyQualifiedTypes: options.fullyQualifiedTypes,
        useHelpersNamespace: false,
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

    for (const { rawBodyTypeName, validatorName } of patchValidators) {
      const { patchBodyTypeName, qualifiedPatchBodyTypeName } =
        resolvePatchBodyInfo(
          rawBodyTypeName,
          modelName,
          qualifiedModelName,
          options,
        );
      const isMergePatchBody = isMergePatchName(rawBodyTypeName);
      const patchProps = buildValidatorProperties(
        program,
        model,
        writeMembers,
        options,
        updateMember,
        versionFilter,
      );
      const patchRefs = isMergePatchBody
        ? deriveMergePatchReferencedValidators(program, options, patchProps)
        : deriveReferencedValidators(program, options, patchProps);
      const data: ValidatorTemplateData = {
        namespace,
        modelsNamespace: options.modelsNamespace,
        helpersNamespace: options.helpersNamespace,
        fullyQualifiedTypes: options.fullyQualifiedTypes,
        useHelpersNamespace:
          !options.fullyQualifiedTypes &&
          isMergePatchBody &&
          options.mergePatchStyle === "generic",
        modelName,
        qualifiedModelName,
        validatorName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        isMergePatchBody: isMergePatchBody || undefined,
        usesJsonOptions:
          (isMergePatchBody && patchRefs.length > 0) || undefined,
        properties: patchProps,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${versionDir}${validatorName}${options.fileExtension}`,
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
  routeModels: ValidatorRouteModels | undefined,
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
      (emitPost &&
        (routeModels === undefined || routeModels.postModels.has(model))) ||
      (emitPatch && routeModels?.nestedPostModels.has(model));
    const patchValidators = emitPatch
      ? patchValidatorsFor(program, model, routeModels)
      : [];

    const qualifiedModelName = computeModelTypeName(program, model, options);
    const modelName = csharpModelName(program, model);

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
        allModels,
      );
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelsNamespace: options.modelsNamespace,
        helpersNamespace: options.helpersNamespace,
        fullyQualifiedTypes: options.fullyQualifiedTypes,
        useHelpersNamespace: false,
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

    for (const { rawBodyTypeName, validatorName } of patchValidators) {
      const { patchBodyTypeName, qualifiedPatchBodyTypeName } =
        resolvePatchBodyInfo(
          rawBodyTypeName,
          modelName,
          qualifiedModelName,
          options,
        );
      const isMergePatchBody = isMergePatchName(rawBodyTypeName);
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
        ? deriveMergePatchReferencedValidators(
            program,
            options,
            baseProperties,
            ...versionGroups.map((g) => g.properties),
          )
        : deriveReferencedValidators(
            program,
            options,
            baseProperties,
            ...versionGroups.map((g) => g.properties),
          );
      const data: VersionAwareValidatorTemplateData = {
        namespace,
        modelsNamespace: options.modelsNamespace,
        helpersNamespace: options.helpersNamespace,
        fullyQualifiedTypes: options.fullyQualifiedTypes,
        useHelpersNamespace:
          !options.fullyQualifiedTypes &&
          isMergePatchBody &&
          options.mergePatchStyle === "generic",
        modelName,
        qualifiedModelName,
        validatorName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        isMergePatchBody: isMergePatchBody || undefined,
        usesJsonOptions:
          (isMergePatchBody && patchRefs.length > 0) || undefined,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
      };
      await emitFile(program, {
        path: resolvePath(
          options.validatorsOutputDir,
          `${validatorName}${options.fileExtension}`,
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
  routeModels: ValidatorRouteModels | undefined,
  options: ResolvedOptions,
  emitPost: boolean,
  emitPatch: boolean,
  isVersionAware: boolean,
  initOpts: EmitValidatorInitializerOptions = {},
): Promise<void> {
  const { versionDirName, versionNsSuffix } = initOpts;

  const registrations: ValidatorRegistration[] = [];
  for (const model of allModels) {
    const qualifiedModelName = computeModelTypeName(program, model, options);
    const modelName = csharpModelName(program, model);

    if (
      (emitPost &&
        (routeModels === undefined || routeModels.postModels.has(model))) ||
      (emitPatch && routeModels?.nestedPostModels.has(model))
    ) {
      registrations.push({
        modelTypeName: modelName,
        qualifiedModelTypeName: qualifiedModelName,
        validatorName: `${modelName}Validator`,
      });
    }
    const patchValidators = emitPatch
      ? patchValidatorsFor(program, model, routeModels)
      : [];
    for (const { rawBodyTypeName, validatorName } of patchValidators) {
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
        validatorName,
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
    modelsNamespace: options.modelsNamespace,
    helpersNamespace: options.helpersNamespace,
    fullyQualifiedTypes: options.fullyQualifiedTypes,
    useHelpersNamespace:
      !options.fullyQualifiedTypes &&
      registrations.some((registration) =>
        registration.qualifiedModelTypeName.startsWith("MergePatch<"),
      ) &&
      options.mergePatchStyle === "generic",
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
 * Reports `merge-patch-recursive-reference` for every property that closes a
 * loop of nested MergePatch validators (`Node → Node`, `A → B → A`).
 *
 * Each MergePatch validator receives the validators of its nested models
 * through its constructor, so a loop would make the validators depend on each
 * other and fail to resolve from dependency injection. Only object-valued
 * properties that can be written in a PATCH form edges: arrays are validated
 * by POST validators, and read-only or create-only properties are rejected
 * without being validated recursively.
 */
function reportMergePatchCycles(
  program: Program,
  allModels: Model[],
  patchModels: Map<Model, Set<string>>,
  createMember: EnumMember | undefined,
  updateMember: EnumMember | undefined,
): void {
  const writeMembers = new Set(
    [createMember, updateMember].filter(
      (m): m is EnumMember => m !== undefined,
    ),
  );
  const isMergePatchModel = (model: Model) =>
    [...(patchModels.get(model) ?? [])].some(isMergePatchName);
  const isPatchWritable = (prop: ModelProperty) =>
    (writeMembers.size === 0 ||
      isVisible(program, prop, { any: writeMembers })) &&
    (!updateMember ||
      isVisible(program, prop, { any: new Set([updateMember]) }));

  const edgesFrom = (model: Model) =>
    classProperties(program, model).flatMap((prop) => {
      if (!isPatchWritable(prop)) return [];
      const reference = getValidatorModelReference(prop.type);
      if (!reference || reference.isCollection) return [];
      if (!isMergePatchModel(reference.model)) return [];
      return [{ prop, target: reference.model }];
    });

  const finished = new Set<Model>();
  const path: Model[] = [];
  const visit = (model: Model): void => {
    path.push(model);
    for (const { prop, target } of edgesFrom(model)) {
      if (finished.has(target)) continue;
      const loopStart = path.indexOf(target);
      if (loopStart >= 0) {
        const cycle = [...path.slice(loopStart), target]
          .map((m) => csharpModelName(program, m))
          .join(" → ");
        reportDiagnostic(program, {
          code: "merge-patch-recursive-reference",
          target: prop,
          format: {
            property: `${csharpModelName(program, model)}.${prop.name}`,
            cycle,
          },
        });
        continue;
      }
      visit(target);
    }
    path.pop();
    finished.add(model);
  };

  for (const model of allModels) {
    if (isMergePatchModel(model) && !finished.has(model)) visit(model);
  }
}

/**
 * Entry point for validator emission. Called from `$onEmit` when
 * `emit-validators` is `true`.
 *
 * @param program - The compiled TypeSpec program.
 * @param options - Resolved emitter options.
 * @param emittedModels - Models that get a C# class; when set, validators are
 *   emitted only for these models.
 */
export async function emitValidators(
  program: Program,
  options: ResolvedOptions,
  emittedModels?: Set<Model>,
): Promise<void> {
  const emitPost =
    options.validatorsTypes === "post" || options.validatorsTypes === "both";
  const emitPatch =
    options.validatorsTypes === "patch" || options.validatorsTypes === "both";

  // Collect user-defined, non-template models that also get a C# class, so a
  // validator never targets a response model, metadata-only model, or a model
  // that is unreachable from any payload.
  const allModels: Model[] = [];
  navigateProgram(program, {
    model(model) {
      if (shouldSkipValidatorModel(model)) return;
      if (emittedModels && !emittedModels.has(model)) return;
      allModels.push(model);
    },
  });

  const routeModels = collectValidatorModelsFromRoutes(program, allModels);

  const lifecycle = getLifecycleVisibilityEnum(program);
  const createMember = lifecycle.members.get("Create");
  const updateMember = lifecycle.members.get("Update");

  if (emitPatch && routeModels) {
    reportMergePatchCycles(
      program,
      allModels,
      routeModels.patchModels,
      createMember,
      updateMember,
    );
  }

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
              allModels,
              routeModels.postModels,
              vf,
            ),
            patchModels: routeModels.patchModels,
            nestedPostModels: collectValidatorTransitiveDeps(
              program,
              allModels,
              routeModels.nestedPostModels,
              vf,
            ),
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
            allModels,
            routeModels.postModels,
          ),
          patchModels: routeModels.patchModels,
          nestedPostModels: collectValidatorTransitiveDeps(
            program,
            allModels,
            routeModels.nestedPostModels,
          ),
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
            allModels,
            routeModels.postModels,
            versionFilter,
          ),
          patchModels: routeModels.patchModels,
          nestedPostModels: collectValidatorTransitiveDeps(
            program,
            allModels,
            routeModels.nestedPostModels,
            versionFilter,
          ),
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
