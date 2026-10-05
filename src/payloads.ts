/**
 * @module payloads
 *
 * Decides which TypeSpec models are *data* (and therefore get a C# class), and
 * which of their properties become class properties, by asking
 * `@typespec/http` how each operation's request and response bodies resolve
 * rather than emitting every model in the type graph.
 *
 * Terminology (see https://typespec.io/docs/libraries/http/operations/):
 * - A **metadata** property is one marked `@statusCode`, `@header`, `@cookie`,
 *   `@query` or `@path`.
 * - A **metadata-only model** has only metadata properties (e.g. `OkResponse`,
 *   or `model ETagHeader { @header etag: string; }`). It describes HTTP
 *   envelope details, not a data shape, and is never emitted.
 * - A **response model** describes an HTTP response rather than data. When it
 *   has an explicit `@body` / `@bodyRoot`, only the body type is data and the
 *   response model itself is never emitted. When it mixes metadata with plain
 *   properties and has no explicit body, the plain properties form an
 *   *implicit body* and the model is emitted without its envelope properties.
 *
 * Metadata-only and explicit-body models are collectively *envelope models*.
 * Header, cookie and status-code properties are *envelope properties*: they
 * never travel as JSON in a response, so no class ever declares them.
 */

import {
  Model,
  Program,
  type ModelProperty,
  type Type,
  getDiscriminator,
  getTypeName,
  isArrayModelType,
  isRecordModelType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  isBody,
  isBodyRoot,
  isCookieParam,
  isHeader,
  isMetadata,
  isMultipartBodyProperty,
  isStatusCode,
} from "@typespec/http";
import {
  getMergePatchSource,
  isMergePatch,
} from "@typespec/http/experimental/merge-patch";
import { reportDiagnostic } from "./lib.js";
import { shouldEmitModel } from "./models.js";
import { csharpModelName } from "./naming.js";

/**
 * Returns `true` when every property of `model` (including inherited ones) is
 * HTTP metadata. A model with no properties is not metadata-only.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to inspect.
 */
export function isMetadataOnlyModel(program: Program, model: Model): boolean {
  const properties = [...walkPropertiesInherited(model)];
  return (
    properties.length > 0 &&
    properties.every((property) => isMetadata(program, property))
  );
}

/**
 * Returns `true` when `model` (or a base model) declares an explicit
 * `@body`, `@bodyRoot` or `@multipartBody` property.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to inspect.
 */
export function hasExplicitBody(program: Program, model: Model): boolean {
  for (const property of walkPropertiesInherited(model)) {
    if (
      isBody(program, property) ||
      isBodyRoot(program, property) ||
      isMultipartBodyProperty(program, property)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns `true` for models that describe an HTTP envelope rather than data:
 * metadata-only models and response models with an explicit body. Envelope
 * models never get a class.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to inspect.
 */
export function isHttpEnvelopeModel(program: Program, model: Model): boolean {
  return isMetadataOnlyModel(program, model) || hasExplicitBody(program, model);
}

/**
 * Returns `true` for `@header`, `@cookie` and `@statusCode` properties. These
 * describe the HTTP envelope and never appear in a JSON body, so they are
 * never emitted as class properties. `@path` and `@query` properties are not
 * envelope properties: on a returned resource they are ordinary body data.
 *
 * @param program - The compiled TypeSpec program.
 * @param property - The property to inspect.
 */
export function isEnvelopeProperty(
  program: Program,
  property: ModelProperty,
): boolean {
  return (
    isHeader(program, property) ||
    isCookieParam(program, property) ||
    isStatusCode(program, property)
  );
}

/**
 * Returns `true` when `type` refers to an envelope model, directly or through
 * an array, record, union or tuple. Such a type has no emitted class to
 * reference.
 *
 * @param program - The compiled TypeSpec program.
 * @param type - The property type to inspect.
 */
function referencesEnvelopeModel(program: Program, type: Type): boolean {
  switch (type.kind) {
    case "Model":
      if (isArrayModelType(type) || isRecordModelType(type)) {
        return referencesEnvelopeModel(program, type.indexer.value);
      }
      return Boolean(type.name) && isHttpEnvelopeModel(program, type);
    case "Union":
      return [...type.variants.values()].some((variant) =>
        referencesEnvelopeModel(program, variant.type),
      );
    case "UnionVariant":
      return referencesEnvelopeModel(program, type.type);
    case "Tuple":
      return type.values.some((value) =>
        referencesEnvelopeModel(program, value),
      );
    default:
      return false;
  }
}

/**
 * Returns `true` when `property` becomes a property of the emitted C# class:
 * it is not an envelope property and its type does not reference an envelope
 * model (which has no class to point at).
 *
 * @param program - The compiled TypeSpec program.
 * @param property - The property to inspect.
 */
export function isClassProperty(
  program: Program,
  property: ModelProperty,
): boolean {
  return (
    !isEnvelopeProperty(program, property) &&
    !referencesEnvelopeModel(program, property.type)
  );
}

/**
 * Returns the nearest base model that gets a class, skipping envelope models.
 * The C# class derives from this model; properties of the skipped envelope
 * ancestors are flattened into the class by {@link classProperties}.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model whose base chain to walk.
 */
export function emittedBaseModel(
  program: Program,
  model: Model,
): Model | undefined {
  let base = model.baseModel;
  while (base && isHttpEnvelopeModel(program, base)) base = base.baseModel;
  return base;
}

/**
 * Returns the properties declared on `model`'s C# class, in order: properties
 * flattened from skipped envelope base models (furthest ancestor first),
 * then the model's own properties. Every returned property satisfies
 * {@link isClassProperty}.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to list properties for.
 */
export function classProperties(
  program: Program,
  model: Model,
): ModelProperty[] {
  const skippedBases: Model[] = [];
  const emittedBase = emittedBaseModel(program, model);
  for (
    let base = model.baseModel;
    base && base !== emittedBase;
    base = base.baseModel
  ) {
    skippedBases.unshift(base);
  }
  return [...skippedBases, model]
    .flatMap((owner) => [...owner.properties.values()])
    .filter((property) => isClassProperty(program, property));
}

/**
 * Maps a resolved HTTP body type back to the named model it came from.
 *
 * For an implicit body (`model R { @header h: string; name: string; }`), the
 * HTTP library reports an anonymous model holding only the non-metadata
 * properties. This returns the named container model (`R`) instead, so the
 * generated return type references the class that is actually emitted.
 * Every other body type is returned unchanged.
 *
 * @param bodyType - `HttpPayloadBody.type` as resolved by `@typespec/http`.
 * @param bodyProperty - The explicit `@body` / `@bodyRoot` property, if any.
 * @param container - The response (or request) type that holds the body.
 * @returns The type the generated C# should reference.
 */
export function resolvePayloadType(
  bodyType: Type,
  bodyProperty: ModelProperty | undefined,
  container: Type | undefined,
): Type {
  if (
    bodyType.kind !== "Model" ||
    bodyType.name ||
    bodyProperty !== undefined ||
    container?.kind !== "Model" ||
    !container.name ||
    container === bodyType
  ) {
    return bodyType;
  }
  const containerProperties = new Set(
    [...walkPropertiesInherited(container)].map((property) => property.name),
  );
  const isSubset = [...bodyType.properties.keys()].every((name) =>
    containerProperties.has(name),
  );
  return isSubset ? container : bodyType;
}

/**
 * Determines which models get a C# class.
 *
 * When the program has HTTP operations, a model is emitted only if it is
 * reachable from an operation payload: a request body, a response body
 * (resolved by `@typespec/http`, with implicit bodies mapped back to their
 * response model), a parameter type, or — transitively — a class property
 * type, emitted base model, discriminated derived model, array/record
 * element, union variant, or `MergePatchUpdate<T>` source of one of those.
 *
 * When the program has no HTTP operations (a models-only library), every
 * candidate is emitted except envelope models.
 *
 * Envelope models are never emitted. Two models that map to the same C# class
 * name are reported with a `duplicate-model-name` diagnostic and only the
 * first is emitted.
 *
 * @param program - The compiled TypeSpec program.
 * @param candidates - Models that pass {@link shouldEmitModel}, in declaration order.
 * @returns The models to emit, in declaration order.
 */
export function analyzePayloadModels(
  program: Program,
  candidates: Model[],
): Model[] {
  const [services] = getAllHttpServices(program);
  const operations = services.flatMap((service) => service.operations);
  if (operations.length === 0) {
    return withUniqueClassNames(
      program,
      candidates.filter((model) => !isHttpEnvelopeModel(program, model)),
    );
  }

  const reached = new Set<Model>();
  const visited = new Set<Type>();

  const visitType = (type: Type): void => {
    switch (type.kind) {
      case "Model":
        visitModel(type);
        return;
      case "Union":
        for (const variant of type.variants.values()) visitType(variant.type);
        return;
      case "UnionVariant":
        visitType(type.type);
        return;
      case "Tuple":
        for (const value of type.values) visitType(value);
        return;
      default:
        return;
    }
  };

  const visitModel = (model: Model): void => {
    if (visited.has(model)) return;
    visited.add(model);

    if (isArrayModelType(model) || isRecordModelType(model)) {
      visitType(model.indexer.value);
      return;
    }
    if (isMergePatch(program, model)) {
      const source = getMergePatchSource(program, model);
      if (source) visitModel(source);
      return;
    }
    if (!model.name) {
      for (const property of model.properties.values()) {
        visitType(property.type);
      }
      return;
    }
    if (!shouldEmitModel(model) || isHttpEnvelopeModel(program, model)) return;

    reached.add(model);
    for (const property of classProperties(program, model)) {
      visitType(property.type);
    }
    const base = emittedBaseModel(program, model);
    if (base) visitModel(base);
    if (isInDiscriminatedHierarchy(program, model)) {
      for (const derived of model.derivedModels) visitModel(derived);
    }
  };

  for (const operation of operations) {
    for (const parameter of operation.parameters.parameters) {
      visitType(parameter.param.type);
    }
    const requestBody = operation.parameters.body;
    if (requestBody) visitType(requestBody.type);

    for (const response of operation.responses) {
      for (const content of response.responses) {
        const body = content.body;
        if (!body) continue;
        const bodyProperty = "property" in body ? body.property : undefined;
        visitType(resolvePayloadType(body.type, bodyProperty, response.type));
      }
    }
  }

  const ordered = candidates.filter((model) => reached.has(model));
  const extras = [...reached].filter((model) => !candidates.includes(model));
  return withUniqueClassNames(program, [...ordered, ...extras]);
}

/**
 * Drops every model whose C# class name was already taken by an earlier model,
 * reporting a `duplicate-model-name` diagnostic for each. Without this, the
 * later model would silently overwrite the earlier one's file and every
 * reference to either would point at the wrong shape.
 *
 * @param program - The compiled TypeSpec program.
 * @param models - Models to emit, in priority order.
 * @returns The models whose class names are unique.
 */
function withUniqueClassNames(program: Program, models: Model[]): Model[] {
  const byName = new Map<string, Model>();
  const unique: Model[] = [];
  for (const model of models) {
    const className = csharpModelName(program, model).replace(/^@/, "");
    const existing = byName.get(className);
    if (existing) {
      reportDiagnostic(program, {
        code: "duplicate-model-name",
        target: model,
        format: {
          model: getTypeName(model),
          className,
          existing: getTypeName(existing),
        },
      });
      continue;
    }
    byName.set(className, model);
    unique.push(model);
  }
  return unique;
}

/**
 * Returns `true` when `model` or one of its base models carries `@discriminator`,
 * meaning derived models are reachable through polymorphic (de)serialization.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to inspect.
 */
function isInDiscriminatedHierarchy(program: Program, model: Model): boolean {
  for (
    let current: Model | undefined = model;
    current;
    current = current.baseModel
  ) {
    if (getDiscriminator(program, current)) return true;
  }
  return false;
}
