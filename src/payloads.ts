/**
 * @module payloads
 *
 * Decides which TypeSpec models are *data* (and therefore get a C# class) by
 * asking `@typespec/http` how each operation's request and response bodies
 * resolve, rather than emitting every model in the type graph.
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
 *   *implicit body*: the model is emitted with only those properties.
 */

import {
  Model,
  Program,
  type ModelProperty,
  type Type,
  getDiscriminator,
  isArrayModelType,
  isRecordModelType,
  walkPropertiesInherited,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  isBody,
  isBodyRoot,
  isMetadata,
  isMultipartBodyProperty,
} from "@typespec/http";
import {
  getMergePatchSource,
  isMergePatch,
} from "@typespec/http/experimental/merge-patch";
import { shouldEmitModel } from "./models.js";

/** Result of {@link analyzePayloadModels}. */
export interface PayloadModels {
  /** Models that get a C# class, in declaration order. */
  models: Model[];
  /**
   * Implicit-body response models mapped to the names of the properties that
   * form the body. Models absent from this map emit every property.
   */
  bodyProperties: Map<Model, Set<string>>;
}

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
 * metadata-only models and response models with an explicit body.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to inspect.
 */
export function isHttpEnvelopeModel(program: Program, model: Model): boolean {
  return isMetadataOnlyModel(program, model) || hasExplicitBody(program, model);
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
 * (resolved by `@typespec/http`), a parameter type, or — transitively — a
 * property type, base model, discriminated derived model, array/record
 * element, union variant, or `MergePatchUpdate<T>` source of one of those.
 *
 * When the program has no HTTP operations (a models-only library), every
 * candidate is emitted except metadata-only and explicit-body response models.
 *
 * Metadata-only models and explicit-body response models are never emitted.
 *
 * @param program - The compiled TypeSpec program.
 * @param candidates - Models that pass {@link shouldEmitModel}, in declaration order.
 * @returns The models to emit and the body-property filter for implicit bodies.
 */
export function analyzePayloadModels(
  program: Program,
  candidates: Model[],
): PayloadModels {
  const [services] = getAllHttpServices(program);
  const operations = services.flatMap((service) => service.operations);
  if (operations.length === 0) {
    return {
      models: candidates.filter(
        (model) => !isHttpEnvelopeModel(program, model),
      ),
      bodyProperties: new Map(),
    };
  }

  const fullModels = new Set<Model>();
  const implicitBodies = new Map<Model, Set<string>>();
  const visited = new Set<Type>();

  const isDataModel = (model: Model): boolean =>
    shouldEmitModel(model) && !isHttpEnvelopeModel(program, model);

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

  const visitRelatedModels = (model: Model): void => {
    if (model.baseModel) visitModel(model.baseModel);
    if (isInDiscriminatedHierarchy(program, model)) {
      for (const derived of model.derivedModels) visitModel(derived);
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
    if (!isDataModel(model)) return;

    fullModels.add(model);
    for (const property of model.properties.values()) {
      visitType(property.type);
    }
    visitRelatedModels(model);
  };

  const visitImplicitBody = (model: Model, bodyType: Model): void => {
    if (!isDataModel(model)) return;
    const names = implicitBodies.get(model) ?? new Set<string>();
    for (const name of bodyType.properties.keys()) names.add(name);
    implicitBodies.set(model, names);
    for (const property of bodyType.properties.values()) {
      visitType(property.type);
    }
    visitRelatedModels(model);
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
        const payload = resolvePayloadType(
          body.type,
          bodyProperty,
          response.type,
        );
        if (payload !== body.type && payload.kind === "Model") {
          visitImplicitBody(payload, body.type as Model);
        } else {
          visitType(body.type);
        }
      }
    }
  }

  const emitted = new Set<Model>([...fullModels, ...implicitBodies.keys()]);
  const ordered = candidates.filter((model) => emitted.has(model));
  const extras = [...emitted].filter((model) => !candidates.includes(model));

  const bodyProperties = new Map<Model, Set<string>>();
  for (const [model, names] of implicitBodies) {
    if (!fullModels.has(model)) bodyProperties.set(model, names);
  }

  return { models: [...ordered, ...extras], bodyProperties };
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
