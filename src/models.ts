/**
 * @module models
 *
 * Emits C# model classes, `I<Model>` interfaces, and enums (both explicit
 * TypeSpec enums and enums inferred from anonymous string-literal unions).
 *
 * The main export is {@link emitModelsAndEnums}, called by the emitter once
 * all models and enums have been collected from the compiled program.
 */

import {
  Enum,
  Model,
  ModelProperty,
  Namespace,
  Program,
  type Type,
  Value,
  emitFile,
  getDiscriminatedUnionFromInheritance,
  getDiscriminator,
  getDoc,
  getEncode,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  resolvePath,
} from "@typespec/compiler";
import {
  getMergePatchSource,
  isMergePatch,
} from "@typespec/http/experimental/merge-patch";
import { getServerName } from "./decorators.js";
import {
  ResolvedOptions,
  csharpNamespaceFor,
  folderSegments,
} from "./emitter.js";
import {
  ClassView,
  DiscriminatedTypeView,
  DiscriminatorView,
  EnumView,
  InterfaceView,
  PropertyView,
  Renderer,
  renderDocComment,
} from "./renderer.js";
import { SCALAR_MAP, FORMAT_MAP, pascalCase, camelCase } from "./utils.js";

/** `using` directives included in every model / interface / enum file. */
export const SYSTEM_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Text.Json.Serialization",
];

/** `using` directives included in every enum file. */
export const ENUM_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Runtime.Serialization",
  "System.Text.Json.Serialization",
];

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
 * Emits one `<Model>.g.cs` and (optionally) `I<Model>.g.cs` per TypeSpec
 * model, one `<Name>.g.cs` per TypeSpec enum, and one file per inferred enum
 * (an anonymous string-literal union used as a property type).
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param models - Models collected by the emitter (already filtered).
 * @param enums - Enums collected by the emitter (already filtered).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
export async function emitModelsAndEnums(
  program: Program,
  models: Model[],
  enums: Enum[],
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
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
    const classUsings = collectUsings(options);
    const interfaceUsings = collectUsings(options);

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
export function shouldEmitModel(model: Model): boolean {
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
export function shouldEmitEnum(en: Enum): boolean {
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
 * Builds the sorted list of `using` namespaces for a single emitted model or
 * interface file.
 *
 * Model, enum, and helper (`MergePatch<T>`) references are always emitted as
 * fully-qualified type names (see {@link typeReference}), so this only needs
 * {@link SYSTEM_USINGS} plus any `additional-usings` from options.
 *
 * @param options - Resolved options (additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function collectUsings(options: ResolvedOptions): string[] {
  const usings = new Set<string>(SYSTEM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
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

  const discriminator = buildDiscriminatorView(program, model, options);

  return {
    doc: docFor(program, model),
    className,
    interfaceName: options.emitInterfaces
      ? `${options.interfacesNamespace}.I${safeClassName}`
      : undefined,
    baseClass: model.baseModel
      ? typeReference(model.baseModel, options, program)
      : undefined,
    properties: buildPropertyViews(program, model, options),
    discriminator,
    isAbstract: discriminator !== undefined,
  };
}

/**
 * Finds the discriminator property name governing `model`, searching `model`
 * itself and then its base-model chain.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node to inspect.
 * @returns The `@discriminator` property name in effect for this model, or
 *   `undefined` if the model does not participate in a discriminated hierarchy.
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
 * Builds a {@link DiscriminatorView} for a model carrying `@discriminator`.
 *
 * Resolves every derived model reachable through the inheritance tree down to
 * a concrete discriminator value (recursing through intermediate models that
 * don't redeclare the discriminator property) via
 * {@link getDiscriminatedUnionFromInheritance}. The discriminator property
 * itself is intentionally omitted from {@link ClassView.properties} (see
 * {@link buildPropertyViews}) — System.Text.Json rejects a declared property
 * name that collides with `TypeDiscriminatorPropertyName`.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node to inspect.
 * @returns A populated discriminator view, or `undefined` when `model` has no
 *   `@discriminator` decorator of its own.
 */
function buildDiscriminatorView(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): DiscriminatorView | undefined {
  const discriminator = getDiscriminator(program, model);
  if (!discriminator) return undefined;

  const [union] = getDiscriminatedUnionFromInheritance(model, discriminator);
  const derivedTypes: DiscriminatedTypeView[] = [...union.variants.entries()]
    .map(([discriminatorValue, derivedModel]) => ({
      className: `${options.modelsNamespace}.${getServerName(program, derivedModel) ?? pascalCase(derivedModel.name)}`,
      discriminatorValue,
    }))
    .sort((a, b) => a.discriminatorValue.localeCompare(b.discriminatorValue));

  return {
    propertyName: camelCase(discriminator.propertyName),
    derivedTypes,
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
      ? `${options.interfacesNamespace}.I${baseIfaceName.startsWith("@") ? baseIfaceName.slice(1) : baseIfaceName}`
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
 * @param options - Resolved options (namespace used to qualify the enum type).
 * @returns A C# initializer expression string, or `undefined` if unsupported.
 */
function defaultValueInitializer(
  value: Value,
  options: ResolvedOptions,
): string | undefined {
  switch (value.valueKind) {
    case "EnumValue": {
      const member = value.value;
      return `${options.modelsNamespace}.${pascalCase(member.enum.name)}.${pascalCase(member.name)}`;
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
  const discriminatorPropertyName = discriminatorPropertyNameInHierarchy(
    program,
    model,
  );
  return [...model.properties.values()]
    .filter((prop) => prop.name !== discriminatorPropertyName)
    .map((prop) => {
      const encoding = resolvePropertyEncoding(program, prop, options);
      const type = propertyTypeName(
        program,
        model,
        prop,
        options,
        encoding.typeOverride,
      );
      const inferredEnumType = inferredEnumTypeNameForProperty(model, prop);
      const qualifiedInferredEnumType = inferredEnumType
        ? `${options.modelsNamespace}.${inferredEnumType}`
        : undefined;
      return {
        doc: docFor(program, prop),
        type,
        name: getServerName(program, prop) ?? pascalCase(prop.name),
        jsonName: camelCase(prop.name),
        nullable: type.endsWith("?"),
        attributes: encoding.attributes,
        initializer: resolveInitializer(
          prop.defaultValue,
          qualifiedInferredEnumType,
          options,
        ),
      };
    });
}

/**
 * Resolves a C# property initializer expression for a default value.
 *
 * When the property has an inferred enum type and the default is a string
 * literal (anonymous string union), converts `"available"` → `Ns.PetStatus.Available`
 * instead of the raw string. Falls back to {@link defaultValueInitializer} for
 * all other cases.
 *
 * @param qualifiedInferredEnumType - Fully-qualified inferred enum type name,
 *   already prefixed with `options.modelsNamespace`.
 */
function resolveInitializer(
  value: Value | undefined,
  qualifiedInferredEnumType: string | undefined,
  options: ResolvedOptions,
): string | undefined {
  if (value === undefined) return undefined;
  if (qualifiedInferredEnumType && value.valueKind === "StringValue") {
    return `${qualifiedInferredEnumType}.${pascalCase(value.value)}`;
  }
  return defaultValueInitializer(value, options);
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
 * TypeSpec scalar names (walking the base-scalar chain) that represent a
 * date/time instant.  `@encode("unixTimestamp", <int>)` on one of these maps
 * the property to the integer wire type instead of `DateTimeOffset`.
 */
const DATETIME_SCALARS = new Set(["utcDateTime", "offsetDateTime"]);

/** TypeSpec scalar names representing a whole-number type. */
const INTEGER_SCALARS = new Set([
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
]);

/** TypeSpec scalar names representing any numeric type (integer or real). */
const NUMERIC_SCALARS = new Set([
  ...INTEGER_SCALARS,
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
  "numeric",
]);

/**
 * Result of resolving an `@encode` decorator on a model property.
 */
interface EncodeResolution {
  /**
   * C# type that overrides the default scalar/format mapping (non-nullable),
   * or `undefined` to keep the default type.  Used when the encoding changes
   * the wire type itself (e.g. a unix-timestamp `utcDateTime` becomes `long`).
   */
  typeOverride?: string;
  /**
   * Serialization attributes to emit on the property, e.g.
   * `[JsonNumberHandling(...)]` or a `[JsonConverter(...)]` reference.
   */
  attributes: string[];
  /**
   * `true` when the property depends on the emitted `BooleanStringJsonConverter`
   * helper, so the helper file must also be emitted.
   */
  usesBooleanStringConverter: boolean;
}

/** An {@link EncodeResolution} that applies no changes. */
const NO_ENCODING: EncodeResolution = {
  attributes: [],
  usesBooleanStringConverter: false,
};

/**
 * Returns the first scalar name in `type`'s base-scalar chain that is known to
 * {@link SCALAR_MAP} (falling back to the declared name), or `undefined` when
 * `type` is not a scalar.  This canonicalises custom scalars
 * (`scalar epoch extends utcDateTime`) to their built-in ancestor.
 */
function knownScalarName(type: Type): string | undefined {
  if (type.kind !== "Scalar") return undefined;
  let current: typeof type | undefined = type;
  while (current) {
    if (SCALAR_MAP[current.name]) return current.name;
    current = current.baseScalar;
  }
  return type.name;
}

/**
 * Resolves the effect of an `@encode` decorator on a model property.
 *
 * Supported encodings (all others are ignored, leaving the default mapping):
 * - **date/time → unix timestamp** (`@encode("unixTimestamp", int32|int64)`):
 *   the property becomes the integer wire type. No converter required.
 * - **duration → seconds** (`@encode("seconds", int32|float64|…)`): the
 *   property becomes the numeric wire type. No converter required.
 * - **numeric → string** (`@encode(string)`): the numeric C# type is kept and
 *   `[JsonNumberHandling]` is added so `System.Text.Json` reads/writes the
 *   number as a JSON string (useful for `int64`/`decimal` precision).
 * - **boolean → string** (`@encode(string)`, new in TypeSpec 1.14.0): a
 *   `[JsonConverter]` referencing the emitted `BooleanStringJsonConverter`
 *   helper serializes the `bool` as `"true"`/`"false"`.
 *
 * @param program - The compiled TypeSpec program.
 * @param prop - The model property to inspect.
 * @param options - Resolved options (helpers namespace for the converter ref).
 * @returns The resolved encoding effect; {@link NO_ENCODING} when nothing applies.
 */
function resolvePropertyEncoding(
  program: Program,
  prop: ModelProperty,
  options: ResolvedOptions,
): EncodeResolution {
  const encode =
    getEncode(program, prop) ??
    (prop.type.kind === "Scalar" ? getEncode(program, prop.type) : undefined);
  if (!encode) return NO_ENCODING;

  const source = knownScalarName(prop.type);
  if (!source) return NO_ENCODING;

  const target = knownScalarName(encode.type);
  const encodeAsString = target === "string" || encode.encoding === "string";

  // date/time → integer (unix timestamp).
  if (DATETIME_SCALARS.has(source) && target && INTEGER_SCALARS.has(target)) {
    return {
      typeOverride: typeReference(encode.type, options, program),
      attributes: [],
      usesBooleanStringConverter: false,
    };
  }

  // duration → numeric (seconds and similar).
  if (source === "duration" && target && NUMERIC_SCALARS.has(target)) {
    return {
      typeOverride: typeReference(encode.type, options, program),
      attributes: [],
      usesBooleanStringConverter: false,
    };
  }

  // numeric → string.
  if (NUMERIC_SCALARS.has(source) && encodeAsString) {
    return {
      attributes: [
        "[JsonNumberHandling(JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString)]",
      ],
      usesBooleanStringConverter: false,
    };
  }

  // boolean → string (TypeSpec 1.14.0).
  if (source === "boolean" && encodeAsString) {
    return {
      attributes: [
        `[JsonConverter(typeof(${options.helpersNamespace}.BooleanStringJsonConverter))]`,
      ],
      usesBooleanStringConverter: true,
    };
  }

  return NO_ENCODING;
}

/**
 * Returns `true` when any property of `model` uses `@encode(string)` on a
 * boolean, meaning the `BooleanStringJsonConverter` helper must be emitted.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to scan.
 * @param options - Resolved emitter options.
 */
export function modelUsesBooleanStringEncoding(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): boolean {
  for (const prop of model.properties.values()) {
    if (
      resolvePropertyEncoding(program, prop, options).usesBooleanStringConverter
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the C# type string for a model property, including nullability.
 *
 * An `@encode` type override (from {@link resolvePropertyEncoding}) takes
 * precedence over `@format` and the default scalar mapping.  Otherwise checks
 * `@format` annotations (on the property and its scalar type) before falling
 * through to {@link typeReference}.  Appends `?` when the property is optional
 * or when `nullable-properties` is enabled.
 *
 * @param program - The compiled TypeSpec program.
 * @param prop - The model property to resolve.
 * @param options - Resolved options for nullability and format mapping.
 * @param typeOverride - Optional C# type from an `@encode` decorator that
 *   overrides the default mapping.
 * @returns C# type string, possibly suffixed with `?`.
 */
function propertyTypeName(
  program: Program,
  model: Model,
  prop: ModelProperty,
  options: ResolvedOptions,
  typeOverride?: string,
): string {
  let type: string;
  if (typeOverride) {
    type = typeOverride;
  } else {
    const propFormat = getFormat(program, prop);
    const scalarFormat =
      prop.type.kind === "Scalar" ? getFormat(program, prop.type) : undefined;
    const format = propFormat ?? scalarFormat;
    if (format && FORMAT_MAP[format.toLowerCase()]) {
      type = FORMAT_MAP[format.toLowerCase()];
    } else {
      const inferredEnumType = inferredEnumTypeNameForProperty(model, prop);
      type = inferredEnumType
        ? `${options.modelsNamespace}.${inferredEnumType}`
        : typeReference(prop.type, options, program);
    }
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
 * References to emitted models/enums are always fully qualified with
 * `options.modelsNamespace` (and `MergePatch<T>` with `options.helpersNamespace`)
 * so generated code never depends on a `using` directive to resolve — this
 * holds even when the reference is within the same namespace.
 *
 * When `program` is supplied, `@serverName` overrides on referenced models are
 * honoured so that renamed models are referenced by their C# identifier rather
 * than their TypeSpec name.
 *
 * @param type - The TypeSpec type node to resolve.
 * @param options - Resolved emitter options (namespaces for qualification).
 * @param program - Optional compiled TypeSpec program used to look up `@serverName`.
 * @returns C# type string (non-nullable).
 */
function typeReference(
  type: Type,
  options: ResolvedOptions,
  program?: Program,
): string {
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
        return `IList<${typeReference(type.indexer.value, options, program)}>`;
      }
      if (isRecordModelType(type)) {
        return `IDictionary<string, ${typeReference(type.indexer.value, options, program)}>`;
      }
      if (program && isMergePatch(program, type)) {
        const source = getMergePatchSource(program, type);
        if (source) {
          const sourceName =
            getServerName(program, source) ?? pascalCase(source.name);
          return `${options.helpersNamespace}.MergePatch<${options.modelsNamespace}.${sourceName}>`;
        }
      }
      const modelName =
        (program ? getServerName(program, type) : undefined) ??
        (type.name ? pascalCase(type.name) : undefined);
      return modelName ? `${options.modelsNamespace}.${modelName}` : "object";
    }
    case "Enum":
      return `${options.modelsNamespace}.${pascalCase(type.name)}`;
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
        const ref = typeReference(nonNull[0].type, options, program);
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
