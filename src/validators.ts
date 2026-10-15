/**
 * @module validators
 *
 * Emits FluentValidation-style `AbstractValidator<T>` classes for POST, PUT and
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
  getMaxItems,
  getMaxLength,
  getMaxValue,
  getMaxValueExclusive,
  getMinItems,
  getMinLength,
  getMinValue,
  getMinValueExclusive,
  getPattern,
  isArrayModelType,
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
  getMadeOptionalOn,
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
import { classProperties, emittedBaseModel } from "./payloads.js";
import { pascalCase, SCALAR_MAP } from "./utils.js";

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

/**
 * Partials shared by the built-in validator templates, keyed by partial name.
 * Custom templates can include them too (see `docs/custom-templates.md`).
 */
const VALIDATOR_PARTIALS: Record<string, string> = {
  mergePatchNestedRules: "validator-merge-patch-nested.hbs",
  mergePatchPropertyRules: "validator-merge-patch-property-rules.hbs",
  typedPropertyRules: "validator-typed-property-rules.hbs",
  propertyRules: "validator-property-rules.hbs",
  validatorRules: "validator-rules.hbs",
  validatorFields: "validator-fields.hbs",
  validatorHelpers: "validator-helpers.hbs",
};

/**
 * Compiles a validator template, first registering the partials that the
 * built-in templates share so custom templates can include them too.
 */
function loadValidatorTemplate(path: string): Handlebars.TemplateDelegate {
  for (const [name, file] of Object.entries(VALIDATOR_PARTIALS)) {
    if (!Handlebars.partials[name]) {
      Handlebars.registerPartial(
        name,
        readFileSync(resolve(TEMPLATES_DIR, file), "utf-8"),
      );
    }
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
 * A numeric bound, carried as an object so that Handlebars'
 * `{{#if numericRule}}` resolves to `true` even when the value is `0`.
 */
interface NumericRule {
  value: number;
  /**
   * C# literal typed to the property (`0.5m`, `2.5f`, `5L`, `(short)5`), so
   * FluentValidation's comparison rules compile for every numeric type.
   */
  formatted: string;
  /** The bound as a `decimal` literal (`0.5m`), compared against MergePatch JSON numbers. */
  decimalLiteral: string;
  /** The bound as plain text for comments and messages (`0.5`). */
  display: string;
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
   * absent field.
   */
  nullable: boolean;
  /**
   * True when a typed (POST or plain PATCH) validator rejects a supplied
   * read-only value with `Null()`. False when the property cannot hold `null`,
   * or when it has a default value: the model's initializer sets that default
   * whenever the field is absent, so `Null()` would reject every request.
   */
  rejectWithNull?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Name of the `static readonly Regex` field that holds `pattern`. */
  patternField?: string;
  emailAddress: boolean;
  isInEnum: boolean;
  enumTypeName?: string;
  minValue?: NumericRule;
  maxValue?: NumericRule;
  minValueExclusive?: NumericRule;
  maxValueExclusive?: NumericRule;
  minItems?: number;
  maxItems?: number;
  referencedModelName?: string;
  /** Kept for FQ name computation; not serialized to Handlebars templates. */
  referencedModel?: Model;
  referencedQualifiedModelName?: string;
  referencedParamName?: string;
  /** True for an array of models; each item is validated. */
  isCollectionReference?: boolean;
  /** True for a `Record<Model>`; each value is validated. */
  isRecordReference?: boolean;
  /**
   * C# expression for the child validator in POST and plain PATCH validators:
   * the constructor parameter, `this` for a self-reference, or a lazy lookup
   * from `serviceProvider` for a reference that closes a cycle.
   */
  referencedValidatorExpression?: string;
  /** True when `referencedValidatorExpression` is a lazy lookup that must be wrapped in a lambda. */
  referencedValidatorLazy?: boolean;
  mergePatchValidatorTypeName?: string;
  mergePatchValidatorParamName?: string;
  mergePatchFactoryTypeName?: string;
  /** Like `referencedValidatorExpression`, for the nested rules of a MergePatch validator. */
  mergePatchValidatorExpression?: string;
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
  /** C# expression for the derived validator; see {@link PropertyData.referencedValidatorExpression}. */
  validatorExpression?: string;
  /** True when `validatorExpression` must be wrapped in a lambda. */
  lazy?: boolean;
}

/** One constructor parameter of a generated validator. */
interface ConstructorParameter {
  type: string;
  name: string;
}

/** A `static readonly Regex` field holding a property's `@pattern`. */
interface PatternField {
  field: string;
  pattern: string;
}

/** Template data shared by every validator template. */
interface ValidatorTemplateDataBase {
  namespace?: string;
  modelsNamespace: string;
  helpersNamespace: string;
  fullyQualifiedTypes: boolean;
  useHelpersNamespace: boolean;
  modelName: string;
  /** Fully-qualified C# type name of the validated model (e.g. `MyApp.Models.Pet`). */
  qualifiedModelName: string;
  /** True for PATCH validators. */
  isPatch?: boolean;
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
  referencedValidators?: ReferencedValidator[];
  /** Derived type validators for polymorphic dispatch (SetInheritanceValidator). */
  derivedTypeValidators?: DerivedTypeValidator[];
  /** Every constructor parameter, in order. Filled in by {@link resolveValidatorDependencies}. */
  constructorParameters: ConstructorParameter[];
  /** True when a child validator is resolved lazily from `serviceProvider`. */
  usesServiceProvider?: boolean;
  /** `static readonly Regex` fields for `@pattern` rules. */
  patternFields: PatternField[];
  /** True when the class needs the `IsMatch` helper. */
  usesPatterns?: boolean;
  /** True when a MergePatch validator needs the `TryGetNumber` helper. */
  usesNumberRules?: boolean;
  /** True when the class declares fields before its constructor. */
  hasFields?: boolean;
}

/** Data passed to the Handlebars POST / PATCH validator template. */
interface ValidatorTemplateData extends ValidatorTemplateDataBase {
  properties: PropertyData[];
}

/** A group of properties validated only in some API versions. */
interface VersionGroup {
  /** First version the group applies to. */
  sinceVersion: string;
  /** First version the group no longer applies to; `undefined` when it applies to the latest. */
  untilVersion?: string;
  /** Human-readable range for the generated comment (e.g. `v2.0 and later`). */
  label: string;
  /** C# condition that is true for the group's versions. */
  condition: string;
  properties: PropertyData[];
}

/** Data passed to the version-aware Handlebars validator templates. */
interface VersionAwareValidatorTemplateData extends ValidatorTemplateDataBase {
  allVersions: string[];
  defaultVersion: string;
  baseProperties: PropertyData[];
  versionGroups: VersionGroup[];
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
  /**
   * Models that are a PUT body. They are validated by the same validator as a
   * POST body, but without the create-only rejection rules, because a PUT
   * may create or replace a resource.
   */
  putModels: Set<Model>;
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

/** How a bound is written for one C# numeric type. */
interface NumericBoundType {
  /** True for integer types: fractional bounds are rounded to the nearest valid integer. */
  integer: boolean;
  /** True for unsigned types: negative literals don't compile. */
  unsigned?: boolean;
  /** Turns the bound's text into a C# literal of this type. */
  literal: (text: string) => string;
}

/** C# numeric types that bound rules are emitted for, keyed by C# type name. */
const NUMERIC_BOUND_TYPES: Record<string, NumericBoundType> = {
  sbyte: { integer: true, literal: (text) => `(sbyte)${text}` },
  byte: { integer: true, unsigned: true, literal: (text) => `(byte)${text}` },
  short: { integer: true, literal: (text) => `(short)${text}` },
  ushort: {
    integer: true,
    unsigned: true,
    literal: (text) => `(ushort)${text}`,
  },
  int: { integer: true, literal: (text) => text },
  uint: { integer: true, unsigned: true, literal: (text) => `${text}u` },
  long: { integer: true, literal: (text) => `${text}L` },
  ulong: { integer: true, unsigned: true, literal: (text) => `${text}UL` },
  float: { integer: false, literal: (text) => `${text}f` },
  double: { integer: false, literal: (text) => `${text}d` },
  decimal: { integer: false, literal: (text) => `${text}m` },
};

/**
 * Returns how bounds are written for `type`, by walking its base-scalar chain
 * to the first scalar with a known C# mapping. Returns `undefined` for
 * non-numeric types.
 */
function numericBoundType(type: Type): NumericBoundType | undefined {
  const nonNull = getNonNullType(type);
  if (nonNull?.kind !== "Scalar") return undefined;
  for (
    let current: Scalar | undefined = nonNull as Scalar;
    current;
    current = current.baseScalar
  ) {
    const csharpType = SCALAR_MAP[current.name];
    if (csharpType) return NUMERIC_BOUND_TYPES[csharpType];
  }
  return undefined;
}

/** How a bound compares against the value; decides the rounding of integer bounds. */
type BoundKind = "min" | "max" | "minExclusive" | "maxExclusive";

/**
 * Builds the {@link NumericRule} for a `@minValue` / `@maxValue` family bound.
 *
 * For an integer property, a fractional bound is rounded to the integer bound
 * that accepts exactly the same integers (`>= 0.5` → `>= 1`, `> 0.5` → `> 0`),
 * because a fractional literal does not convert to an integer type. Returns
 * `undefined` when the bound is negative on an unsigned type, where it accepts
 * every value and its literal would not compile.
 */
function numericRule(
  value: number | undefined,
  kind: BoundKind,
  boundType: NumericBoundType | undefined,
): NumericRule | undefined {
  if (value === undefined) return undefined;
  if (!boundType) {
    const text = String(value);
    return {
      value,
      formatted: text,
      decimalLiteral: `${text}m`,
      display: text,
    };
  }
  let bound = value;
  if (boundType.integer && !Number.isInteger(bound)) {
    bound =
      kind === "min" || kind === "maxExclusive"
        ? Math.ceil(bound)
        : Math.floor(bound);
  }
  if (boundType.unsigned && bound < 0) return undefined;
  const text =
    boundType.integer && !Number.isSafeInteger(bound)
      ? BigInt(bound).toString()
      : String(bound);
  return {
    value: bound,
    formatted: boundType.literal(text),
    decimalLiteral: `${text}m`,
    display: text,
  };
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

/** How a property holds a referenced model: directly, as array items, or as record values. */
type ModelReferenceKind = "object" | "array" | "record";

/**
 * If `type` is a user-defined model, an array of user-defined models, or a
 * `Record` of user-defined models, returns the referenced model and how it is
 * held. Returns `undefined` for scalars, enums, unions, built-in models, and
 * collections of non-models.
 */
function getValidatorModelReference(
  type: Type,
): { model: Model; kind: ModelReferenceKind } | undefined {
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
    return {
      model: elemModel,
      kind: isArrayModelType(m) ? "array" : "record",
    };
  }
  if (shouldSkipValidatorModel(m)) return undefined;
  return { model: m, kind: "object" };
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
 * Returns the properties a validator for `model` checks: the properties of
 * its C# class plus those it inherits from emitted base classes, base-most
 * first. A property redeclared by a derived model replaces the inherited one
 * in place.
 */
function validatorProperties(program: Program, model: Model): ModelProperty[] {
  const chain: Model[] = [];
  for (
    let current: Model | undefined = model;
    current;
    current = emittedBaseModel(program, current)
  ) {
    chain.unshift(current);
  }
  const byName = new Map<string, ModelProperty>();
  for (const owner of chain) {
    for (const prop of classProperties(program, owner)) {
      byName.set(prop.name, prop);
    }
  }
  return [...byName.values()];
}

/** Lower-cases the first character, for parameter and field names. */
function camelFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Extracts all constraint data for a single model property.
 *
 * @param isReadOnly - The property must be rejected when supplied.
 * @param isImmutable - The rejection is because the property belongs to a
 *   different lifecycle phase (see {@link PropertyData.isImmutable}).
 * @param optional - Overrides `prop.optional`, for a version in which the
 *   property was still required (`@madeOptional`).
 */
function buildSinglePropertyData(
  program: Program,
  prop: ModelProperty,
  options: ResolvedOptions,
  isReadOnly = false,
  isImmutable = false,
  optional = prop.optional,
): PropertyData {
  const hasDefault = prop.defaultValue !== undefined;
  const nullable = isNullableForValidator(
    program,
    prop,
    options.nullableProperties,
  );
  const isRequired = !isReadOnly && !optional && !hasDefault;
  const notEmpty =
    isRequired &&
    (isStringScalar(prop.type) || isStringLiteralUnion(prop.type));
  const rejectNull = isRequired && !typeAllowsNull(prop.type);
  const notNull = rejectNull && !notEmpty && nullable;
  const name = getServerName(program, prop) ?? pascalCase(prop.name);

  if (isReadOnly) {
    return {
      name,
      hasRules: true,
      notEmpty,
      notNull,
      rejectNull,
      isReadOnly: true,
      isImmutable: isImmutable || undefined,
      nullable,
      rejectWithNull: nullable && !hasDefault,
      emailAddress: false,
      isInEnum: false,
    };
  }

  const minLength =
    getMinLength(program, prop) ?? getMinLength(program, prop.type);
  const maxLength =
    getMaxLength(program, prop) ?? getMaxLength(program, prop.type);
  const pattern = getPattern(program, prop) ?? getPattern(program, prop.type);
  const format = getFormat(program, prop) ?? getFormat(program, prop.type);
  const emailAddress = format === "email";
  const minItems =
    getMinItems(program, prop) ?? getMinItems(program, prop.type);
  const maxItems =
    getMaxItems(program, prop) ?? getMaxItems(program, prop.type);

  const isInEnum = prop.type.kind === "Enum";
  const enumTypeName = isInEnum
    ? qualifyTypeName(
        options.modelsNamespace,
        pascalCase((prop.type as Enum).name),
        options,
      )
    : undefined;

  const boundType = numericBoundType(prop.type);
  const minValue = numericRule(
    getMinValue(program, prop) ?? getMinValue(program, prop.type),
    "min",
    boundType,
  );
  const maxValue = numericRule(
    getMaxValue(program, prop) ?? getMaxValue(program, prop.type),
    "max",
    boundType,
  );
  const minValueExclusive = numericRule(
    getMinValueExclusive(program, prop) ??
      getMinValueExclusive(program, prop.type),
    "minExclusive",
    boundType,
  );
  const maxValueExclusive = numericRule(
    getMaxValueExclusive(program, prop) ??
      getMaxValueExclusive(program, prop.type),
    "maxExclusive",
    boundType,
  );

  const modelRef = getValidatorModelReference(prop.type);
  const referencedModelName = modelRef
    ? csharpModelName(program, modelRef.model)
    : undefined;
  const referencedQualifiedModelName = modelRef
    ? computeModelTypeName(program, modelRef.model, options)
    : undefined;
  // Array items replace the whole array, so they are validated as complete
  // models. Objects and record values are merged, so they are validated as
  // nested patches.
  const mergePatchValidator = modelRef
    ? modelRef.kind === "array"
      ? {
          typeName: referencedQualifiedModelName!,
          paramName: `${camelFirst(referencedModelName!)}Validator`,
          factoryTypeName: undefined,
        }
      : {
          typeName: resolvePatchBodyInfo(
            `MergePatch<${referencedModelName}>`,
            referencedModelName!,
            referencedQualifiedModelName!,
            options,
          ).qualifiedPatchBodyTypeName,
          paramName: `${camelFirst(referencedModelName!)}PatchValidator`,
          factoryTypeName: resolvePatchBodyInfo(
            `MergePatch<${referencedModelName}>`,
            referencedModelName!,
            referencedQualifiedModelName!,
            options,
          ).qualifiedPatchBodyTypeName,
        }
    : undefined;

  const hasRules =
    isRequired ||
    minLength !== undefined ||
    maxLength !== undefined ||
    pattern !== undefined ||
    emailAddress ||
    isInEnum ||
    minValue !== undefined ||
    maxValue !== undefined ||
    minValueExclusive !== undefined ||
    maxValueExclusive !== undefined ||
    minItems !== undefined ||
    maxItems !== undefined ||
    referencedModelName !== undefined;

  return {
    name,
    hasRules,
    notEmpty,
    notNull,
    rejectNull,
    nullable,
    minLength,
    maxLength,
    pattern,
    patternField:
      pattern !== undefined ? `_${camelFirst(name)}Pattern` : undefined,
    emailAddress,
    isInEnum,
    enumTypeName,
    minValue,
    maxValue,
    minValueExclusive,
    maxValueExclusive,
    minItems,
    maxItems,
    referencedModelName,
    referencedModel: modelRef?.model,
    referencedQualifiedModelName,
    referencedParamName: referencedModelName
      ? `${camelFirst(referencedModelName)}Validator`
      : undefined,
    isCollectionReference: modelRef?.kind === "array" || undefined,
    isRecordReference: modelRef?.kind === "record" || undefined,
    mergePatchValidatorTypeName: mergePatchValidator?.typeName,
    mergePatchValidatorParamName: mergePatchValidator?.paramName,
    mergePatchFactoryTypeName: mergePatchValidator?.factoryTypeName,
  };
}

/**
 * Keeps only the required-ness rules of `data`, for the versions before a
 * `@madeOptional` property became optional. Returns `undefined` when there is
 * no such rule.
 */
function requiredRulesOnly(data: PropertyData): PropertyData | undefined {
  if (!data.notEmpty && !data.notNull && !data.rejectNull) return undefined;
  return {
    name: data.name,
    hasRules: true,
    notEmpty: data.notEmpty,
    notNull: data.notNull,
    rejectNull: data.rejectNull,
    nullable: data.nullable,
    emailAddress: false,
    isInEnum: false,
  };
}

/** Index of the version a `@madeOptional` property became optional in, if any. */
function madeOptionalIndex(
  program: Program,
  prop: ModelProperty,
  allVersions: readonly Version[],
): number | undefined {
  const version = getMadeOptionalOn(program, prop);
  if (!version) return undefined;
  const index = allVersions.findIndex((v) => v.name === version.name);
  return index >= 0 ? index : undefined;
}

/** The API version a non-version-aware validator set is emitted for. */
interface TargetVersion {
  allVersions: readonly Version[];
  index: number;
}

/**
 * Builds the `PropertyData` array for all properties of a model,
 * respecting lifecycle visibility and an optional target version.
 * Read-only (non-writable) properties are included with `isReadOnly: true`
 * so validators can emit a rejection rule for them.
 */
function buildValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  options: ResolvedOptions,
  visibilityMember?: EnumMember,
  targetVersion?: TargetVersion,
): PropertyData[] {
  const result: PropertyData[] = [];
  const discriminatorPropertyName = discriminatorPropertyNameInHierarchy(
    program,
    model,
  );
  const versionFilter = targetVersion
    ? makeValidatorVersionFilter(
        program,
        targetVersion.allVersions[targetVersion.index].name,
      )
    : undefined;
  for (const prop of validatorProperties(program, model)) {
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
    const optionalSince = targetVersion
      ? madeOptionalIndex(program, prop, targetVersion.allVersions)
      : undefined;
    const optional =
      optionalSince !== undefined && targetVersion!.index < optionalSince
        ? false
        : prop.optional;
    result.push(
      buildSinglePropertyData(program, prop, options, false, false, optional),
    );
  }
  return result;
}

/**
 * Returns the half-open index ranges `[start, end)` of `allVersions` in which
 * `prop` exists. A property without version metadata exists in every version.
 */
function availabilityRuns(
  program: Program,
  prop: ModelProperty,
  allVersions: readonly Version[],
): [number, number][] {
  const availability = getAvailabilityMap(program, prop);
  if (availability === undefined) return [[0, allVersions.length]];
  const runs: [number, number][] = [];
  let start: number | undefined;
  allVersions.forEach((version, index) => {
    const state = availability.get(version.name);
    const available =
      state === Availability.Added || state === Availability.Available;
    if (available && start === undefined) start = index;
    if (!available && start !== undefined) {
      runs.push([start, index]);
      start = undefined;
    }
  });
  if (start !== undefined) runs.push([start, allVersions.length]);
  return runs;
}

/** Intersects version ranges with `[0, end)`. */
function runsBefore(
  runs: readonly [number, number][],
  end: number,
): [number, number][] {
  return runs
    .filter(([start]) => start < end)
    .map(([start, runEnd]) => [start, Math.min(runEnd, end)]);
}

/**
 * Builds version-aware property data (base properties + versioned groups)
 * for the `"version-aware"` strategy.
 *
 * A property is validated only in the versions it exists in: from the version
 * it was `@added` in up to the version it was `@removed` in. A `@madeOptional`
 * property keeps its required rules in the versions before it became
 * optional. Read-only (non-writable) properties are included with
 * `isReadOnly: true` in every version, so validators can reject them.
 */
function buildVersionAwareValidatorProperties(
  program: Program,
  model: Model,
  writeMembers: Set<EnumMember>,
  visibilityMember: EnumMember | undefined,
  allVersions: readonly Version[],
  options: ResolvedOptions,
): { baseProperties: PropertyData[]; versionGroups: VersionGroup[] } {
  const baseProperties: PropertyData[] = [];
  const groups = new Map<
    string,
    { runs: [number, number][]; properties: PropertyData[] }
  >();
  const discriminatorPropertyName = discriminatorPropertyNameInHierarchy(
    program,
    model,
  );
  const addToRuns = (runs: [number, number][], data: PropertyData) => {
    if (
      runs.length === 1 &&
      runs[0][0] === 0 &&
      runs[0][1] === allVersions.length
    ) {
      baseProperties.push(data);
      return;
    }
    const key = runs.map(([start, end]) => `${start}-${end}`).join(",");
    const group = groups.get(key) ?? { runs, properties: [] };
    group.properties.push(data);
    groups.set(key, group);
  };

  for (const prop of validatorProperties(program, model)) {
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
    const runs = availabilityRuns(program, prop, allVersions);
    if (runs.length === 0) continue;
    addToRuns(runs, buildSinglePropertyData(program, prop, options));

    const optionalSince = madeOptionalIndex(program, prop, allVersions);
    if (optionalSince === undefined) continue;
    const requiredRuns = runsBefore(runs, optionalSince);
    const requiredData = requiredRulesOnly(
      buildSinglePropertyData(program, prop, options, false, false, false),
    );
    if (requiredRuns.length > 0 && requiredData) {
      addToRuns(requiredRuns, requiredData);
    }
  }

  const versionGroups = [...groups.values()]
    .sort((a, b) => a.runs[0][0] - b.runs[0][0] || a.runs[0][1] - b.runs[0][1])
    .map(({ runs, properties }) => versionGroup(runs, properties, allVersions));
  return { baseProperties, versionGroups };
}

/** Builds the comment label and C# condition for a group of version ranges. */
function versionGroup(
  runs: readonly [number, number][],
  properties: PropertyData[],
  allVersions: readonly Version[],
): VersionGroup {
  const count = allVersions.length;
  const value = (index: number) => allVersions[index].value;
  const label = runs
    .map(([start, end]) =>
      end === count
        ? `${value(start)} and later`
        : start === 0
          ? `versions before ${value(end)}`
          : `${value(start)} up to (not including) ${value(end)}`,
    )
    .join(", ");
  const condition = runs
    .map(
      ([start, end]) =>
        `IsVersionInRange("${value(start)}", ${end === count ? "null" : `"${value(end)}"`})`,
    )
    .join(" || ");
  const [firstStart, firstEnd] = runs[0];
  return {
    sinceVersion: value(firstStart),
    untilVersion: firstEnd === count ? undefined : value(firstEnd),
    label,
    condition,
    properties,
  };
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
    derived.push({
      typeName,
      qualifiedTypeName,
      paramName: `${camelFirst(typeName)}Validator`,
    });
  }
  derived.sort((a, b) =>
    a.typeName < b.typeName ? -1 : a.typeName > b.typeName ? 1 : 0,
  );
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
    for (const prop of validatorProperties(program, model)) {
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
 * Collects the sets of models that appear as POST, PUT and PATCH request
 * bodies across all HTTP services. Returns `undefined` when no HTTP
 * operations exist, signalling the caller to fall back to all models.
 *
 * POST and PUT bodies share one validator per model (`postModels`); PUT
 * bodies are also listed in `putModels`.
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
  const putModels = new Set<Model>();
  const patchModels = new Map<Model, Set<string>>();
  const nestedPostModels = new Set<Model>();

  for (const service of services) {
    for (const op of service.operations) {
      if (op.verb !== "post" && op.verb !== "put" && op.verb !== "patch") {
        continue;
      }
      const body = op.parameters.body;
      if (!body || body.bodyKind !== "single") continue;
      const bodyType = (body as HttpOperationBody).type;
      if (bodyType.kind !== "Model") continue;
      const bodyModel = bodyType as Model;
      if (op.verb === "post" || op.verb === "put") {
        addModelWithDescendants(allModels, bodyModel, postModels);
        if (op.verb === "put") {
          addModelWithDescendants(allModels, bodyModel, putModels);
        }
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
        for (const prop of validatorProperties(program, current)) {
          const reference = getValidatorModelReference(prop.type);
          if (!reference) continue;
          if (!isMergePatchBody || reference.kind === "array") {
            nestedPostModels.add(reference.model);
            continue;
          }
          addPatchBody(program, patchModels, reference.model, true);
          pending.push(reference.model);
        }
      }
    }
  }
  return { postModels, putModels, patchModels, nestedPostModels };
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

/** A child validator that a generated validator needs. */
interface ValidatorDependency {
  /** Type argument of the `AbstractValidator<T>` the dependency is resolved as. */
  serviceType: string;
  /** Constructor parameter name used when the dependency is injected. */
  paramName: string;
  /**
   * Writes the resolved C# expression into the template view model.
   * `lazy` is true when the expression must be evaluated per validation.
   */
  apply: (expression: string, lazy: boolean) => void;
}

/** A validator ready to render once its dependencies are resolved. */
interface ValidatorSpec {
  /** Type argument of the validator's `AbstractValidator<T>`; its DI key. */
  serviceType: string;
  path: string;
  template: Handlebars.TemplateDelegate;
  data: ValidatorTemplateData | VersionAwareValidatorTemplateData;
  /** Constructor parameters that come before the child validators. */
  leadingParameters: ConstructorParameter[];
  dependencies: ValidatorDependency[];
}

/**
 * Lists the child validators that `properties` (and, for a discriminated
 * base, its derived types) need.
 */
function collectDependencies(
  propertyGroups: PropertyData[][],
  isMergePatchBody: boolean,
  derivedTypeValidators: DerivedTypeValidator[] | undefined,
): ValidatorDependency[] {
  const dependencies: ValidatorDependency[] = [];
  for (const props of propertyGroups) {
    for (const prop of props) {
      if (!prop.referencedModelName) continue;
      if (isMergePatchBody) {
        dependencies.push({
          serviceType: prop.mergePatchValidatorTypeName!,
          paramName: prop.mergePatchValidatorParamName!,
          apply: (expression) => {
            prop.mergePatchValidatorExpression = expression;
          },
        });
      } else {
        dependencies.push({
          serviceType: prop.referencedQualifiedModelName!,
          paramName: prop.referencedParamName!,
          apply: (expression, lazy) => {
            prop.referencedValidatorExpression = expression;
            prop.referencedValidatorLazy = lazy || undefined;
          },
        });
      }
    }
  }
  for (const derived of derivedTypeValidators ?? []) {
    dependencies.push({
      serviceType: derived.qualifiedTypeName,
      paramName: derived.paramName,
      apply: (expression, lazy) => {
        derived.validatorExpression = expression;
        derived.lazy = lazy || undefined;
      },
    });
  }
  return dependencies;
}

/**
 * Decides how every validator gets its child validators, then fills in each
 * template's constructor parameters and validator expressions.
 *
 * Validators are resolved from dependency injection through their
 * constructors, so a cycle of constructor dependencies could never be
 * resolved. A validator that needs itself (`model Node { children?: Node[] }`)
 * uses `this`. In a longer cycle (`A → B → A`, or a discriminated base whose
 * derived type references the base), the edge that closes the cycle is
 * resolved lazily from `IServiceProvider` at validation time instead of being
 * injected. A child validator needed by several properties, or both by a
 * property and for polymorphic dispatch, is injected once.
 */
function resolveValidatorDependencies(specs: readonly ValidatorSpec[]): void {
  // The last registration for a service type is the one DI resolves.
  const byServiceType = new Map(specs.map((spec) => [spec.serviceType, spec]));
  const lazyServiceTypes = new Map<ValidatorSpec, Set<string>>();
  const state = new Map<ValidatorSpec, "visiting" | "done">();

  const visit = (spec: ValidatorSpec): void => {
    state.set(spec, "visiting");
    for (const { serviceType } of spec.dependencies) {
      const target = byServiceType.get(serviceType);
      if (!target || target === spec) continue;
      const targetState = state.get(target);
      if (targetState === "visiting") {
        const lazy = lazyServiceTypes.get(spec) ?? new Set<string>();
        lazy.add(serviceType);
        lazyServiceTypes.set(spec, lazy);
      } else if (targetState === undefined) {
        visit(target);
      }
    }
    state.set(spec, "done");
  };
  for (const spec of specs) {
    if (!state.has(spec)) visit(spec);
  }

  for (const spec of specs) {
    const lazy = lazyServiceTypes.get(spec) ?? new Set<string>();
    const parameters = [...spec.leadingParameters];
    if (lazy.size > 0) {
      parameters.push({
        type: "System.IServiceProvider",
        name: "serviceProvider",
      });
    }
    const injected = new Map<string, string>();
    for (const dependency of spec.dependencies) {
      if (dependency.serviceType === spec.serviceType) {
        dependency.apply("this", false);
      } else if (lazy.has(dependency.serviceType)) {
        dependency.apply(
          `serviceProvider.GetRequiredService<AbstractValidator<${dependency.serviceType}>>()`,
          true,
        );
      } else {
        let paramName = injected.get(dependency.serviceType);
        if (paramName === undefined) {
          paramName = dependency.paramName;
          injected.set(dependency.serviceType, paramName);
          parameters.push({
            type: `AbstractValidator<${dependency.serviceType}>`,
            name: paramName,
          });
        }
        dependency.apply(paramName, false);
      }
    }
    spec.data.constructorParameters = parameters;
    spec.data.usesServiceProvider = lazy.size > 0 || undefined;
  }
}

/**
 * Fills in the field and helper flags of a validator's template data from
 * its properties.
 */
function finishTemplateData(
  data: ValidatorTemplateDataBase,
  propertyGroups: PropertyData[][],
  isVersionAware: boolean,
): void {
  const fields = new Map<string, PatternField>();
  let usesNumberRules = false;
  for (const props of propertyGroups) {
    for (const prop of props) {
      if (prop.patternField && prop.pattern !== undefined) {
        fields.set(prop.patternField, {
          field: prop.patternField,
          pattern: prop.pattern,
        });
      }
      if (
        prop.minValue ||
        prop.maxValue ||
        prop.minValueExclusive ||
        prop.maxValueExclusive
      ) {
        usesNumberRules = true;
      }
    }
  }
  data.patternFields = [...fields.values()];
  data.usesPatterns = data.patternFields.length > 0 || undefined;
  data.usesNumberRules =
    (data.isMergePatchBody && usesNumberRules) || undefined;
  data.hasFields =
    isVersionAware ||
    data.derivedTypeValidators !== undefined ||
    data.patternFields.length > 0 ||
    undefined;
}

/** Renders resolved validator specs. */
async function renderValidatorSpecs(
  program: Program,
  specs: readonly ValidatorSpec[],
): Promise<void> {
  resolveValidatorDependencies(specs);
  for (const spec of specs) {
    await emitFile(program, {
      path: spec.path,
      // Indented partials also indent their blank lines; drop that whitespace.
      content: spec.template(spec.data).replace(/[ \t]+$/gm, ""),
    });
  }
}

interface EmitValidatorSingleOptions {
  /** The API version this validator set is for, when the spec is versioned. */
  targetVersion?: TargetVersion;
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

/** True when `model` gets the POST (create / replace) validator. */
function needsPostValidator(
  model: Model,
  routeModels: ValidatorRouteModels | undefined,
  emitPost: boolean,
  emitPatch: boolean,
): boolean {
  return (
    (emitPost &&
      (routeModels === undefined || routeModels.postModels.has(model))) ||
    (emitPatch && (routeModels?.nestedPostModels.has(model) ?? false))
  );
}

/**
 * The lifecycle phase whose phase-specific rules the POST validator applies.
 * A PUT body may create or replace a resource, so it gets none.
 */
function postVisibilityMember(
  model: Model,
  routeModels: ValidatorRouteModels | undefined,
  createMember: EnumMember | undefined,
): EnumMember | undefined {
  return routeModels?.putModels.has(model) ? undefined : createMember;
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
  const { targetVersion, versionDirName, versionNsSuffix } = singleOpts;
  const namespace = resolveValidatorNamespace(options, versionNsSuffix);
  const writeMembers = new Set(
    [createMember, updateMember].filter(
      (m): m is EnumMember => m !== undefined,
    ),
  );
  const versionDir = versionDirName ? `${versionDirName}/` : "";
  const specs: ValidatorSpec[] = [];

  for (const model of allModels) {
    const qualifiedModelName = computeModelTypeName(program, model, options);
    const modelName = csharpModelName(program, model);

    if (needsPostValidator(model, routeModels, emitPost, emitPatch)) {
      const postProps = buildValidatorProperties(
        program,
        model,
        writeMembers,
        options,
        postVisibilityMember(model, routeModels, createMember),
        targetVersion,
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
        constructorParameters: [],
        patternFields: [],
      };
      finishTemplateData(data, [postProps], false);
      specs.push({
        serviceType: qualifiedModelName,
        path: resolvePath(
          options.validatorsOutputDir,
          `${versionDir}${modelName}Validator${options.fileExtension}`,
        ),
        template: getValidatorPostTemplate(options.templates["validator-post"]),
        data,
        leadingParameters: [],
        dependencies: collectDependencies(
          [postProps],
          false,
          derivedTypeValidators,
        ),
      });
    }

    const patchValidators = emitPatch
      ? patchValidatorsFor(program, model, routeModels)
      : [];
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
        targetVersion,
      );
      const patchRefs = isMergePatchBody
        ? deriveMergePatchReferencedValidators(program, options, patchProps)
        : deriveReferencedValidators(program, options, patchProps);
      const usesJsonOptions = isMergePatchBody && patchRefs.length > 0;
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
        isPatch: true,
        validatorName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        isMergePatchBody: isMergePatchBody || undefined,
        usesJsonOptions: usesJsonOptions || undefined,
        properties: patchProps,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
        constructorParameters: [],
        patternFields: [],
      };
      finishTemplateData(data, [patchProps], false);
      specs.push({
        serviceType: qualifiedPatchBodyTypeName,
        path: resolvePath(
          options.validatorsOutputDir,
          `${versionDir}${validatorName}${options.fileExtension}`,
        ),
        template: getValidatorPatchTemplate(
          options.templates["validator-patch"],
        ),
        data,
        leadingParameters: usesJsonOptions ? [JSON_OPTIONS_PARAMETER] : [],
        dependencies: collectDependencies(
          [patchProps],
          isMergePatchBody,
          undefined,
        ),
      });
    }
  }
  await renderValidatorSpecs(program, specs);
}

/** Constructor parameter of MergePatch validators that deserialize nested values. */
const JSON_OPTIONS_PARAMETER: ConstructorParameter = {
  type: "Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>",
  name: "jsonOptions",
};

/** Constructor parameter of version-aware validators. */
const HTTP_CONTEXT_ACCESSOR_PARAMETER: ConstructorParameter = {
  type: "IHttpContextAccessor",
  name: "httpContextAccessor",
};

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
  const specs: ValidatorSpec[] = [];

  for (const model of allModels) {
    const qualifiedModelName = computeModelTypeName(program, model, options);
    const modelName = csharpModelName(program, model);

    if (needsPostValidator(model, routeModels, emitPost, emitPatch)) {
      const { baseProperties, versionGroups } =
        buildVersionAwareValidatorProperties(
          program,
          model,
          writeMembers,
          postVisibilityMember(model, routeModels, createMember),
          allVersions,
          options,
        );
      const propertyGroups = [
        baseProperties,
        ...versionGroups.map((g) => g.properties),
      ];
      const postRefs = deriveReferencedValidators(
        program,
        options,
        ...propertyGroups,
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
        constructorParameters: [],
        patternFields: [],
      };
      finishTemplateData(data, propertyGroups, true);
      specs.push({
        serviceType: qualifiedModelName,
        path: resolvePath(
          options.validatorsOutputDir,
          `${modelName}Validator${options.fileExtension}`,
        ),
        template: getValidatorPostVersionAwareTemplate(
          options.templates["validator-post-version-aware"],
        ),
        data,
        leadingParameters: [HTTP_CONTEXT_ACCESSOR_PARAMETER],
        dependencies: collectDependencies(
          propertyGroups,
          false,
          derivedTypeValidators,
        ),
      });
    }

    const patchValidators = emitPatch
      ? patchValidatorsFor(program, model, routeModels)
      : [];
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
      const propertyGroups = [
        baseProperties,
        ...versionGroups.map((g) => g.properties),
      ];
      const patchRefs = isMergePatchBody
        ? deriveMergePatchReferencedValidators(
            program,
            options,
            ...propertyGroups,
          )
        : deriveReferencedValidators(program, options, ...propertyGroups);
      const usesJsonOptions = isMergePatchBody && patchRefs.length > 0;
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
        isPatch: true,
        validatorName,
        patchBodyTypeName,
        qualifiedPatchBodyTypeName,
        isMergePatchBody: isMergePatchBody || undefined,
        usesJsonOptions: usesJsonOptions || undefined,
        allVersions: versionValues,
        defaultVersion,
        baseProperties,
        versionGroups,
        referencedValidators: patchRefs.length > 0 ? patchRefs : undefined,
        constructorParameters: [],
        patternFields: [],
      };
      finishTemplateData(data, propertyGroups, true);
      specs.push({
        serviceType: qualifiedPatchBodyTypeName,
        path: resolvePath(
          options.validatorsOutputDir,
          `${validatorName}${options.fileExtension}`,
        ),
        template: getValidatorPatchVersionAwareTemplate(
          options.templates["validator-patch-version-aware"],
        ),
        data,
        leadingParameters: usesJsonOptions
          ? [HTTP_CONTEXT_ACCESSOR_PARAMETER, JSON_OPTIONS_PARAMETER]
          : [HTTP_CONTEXT_ACCESSOR_PARAMETER],
        dependencies: collectDependencies(
          propertyGroups,
          isMergePatchBody,
          undefined,
        ),
      });
    }
  }
  await renderValidatorSpecs(program, specs);
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

    if (needsPostValidator(model, routeModels, emitPost, emitPatch)) {
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

  const expandRouteModels = (
    versionFilter?: (prop: ModelProperty) => boolean,
  ): ValidatorRouteModels | undefined =>
    routeModels
      ? {
          postModels: collectValidatorTransitiveDeps(
            program,
            allModels,
            routeModels.postModels,
            versionFilter,
          ),
          putModels: routeModels.putModels,
          patchModels: routeModels.patchModels,
          nestedPostModels: collectValidatorTransitiveDeps(
            program,
            allModels,
            routeModels.nestedPostModels,
            versionFilter,
          ),
        }
      : undefined;

  if (
    effectiveStrategy === "per-version" &&
    allVersions &&
    allVersions.length > 0
  ) {
    for (const [index, version] of allVersions.entries()) {
      const vf = makeValidatorVersionFilter(program, version.name);
      const versionNsSuffix =
        version.name.charAt(0).toUpperCase() + version.name.slice(1);
      const expandedRouteModels = expandRouteModels(vf);
      await emitValidatorModels(
        program,
        allModels,
        expandedRouteModels,
        createMember,
        updateMember,
        options,
        emitPost,
        emitPatch,
        {
          targetVersion: { allVersions, index },
          versionDirName: version.name,
          versionNsSuffix,
        },
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
    const expandedRouteModels = expandRouteModels();
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
    let targetVersion: TargetVersion | undefined;
    let versionFilter: ((prop: ModelProperty) => boolean) | undefined;
    if (allVersions && allVersions.length > 0) {
      const index = effectiveStrategy === "latest" ? allVersions.length - 1 : 0;
      targetVersion = { allVersions, index };
      versionFilter = makeValidatorVersionFilter(
        program,
        allVersions[index].name,
      );
    }
    const expandedRouteModels = expandRouteModels(versionFilter);
    await emitValidatorModels(
      program,
      allModels,
      expandedRouteModels,
      createMember,
      updateMember,
      options,
      emitPost,
      emitPatch,
      { targetVersion },
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
