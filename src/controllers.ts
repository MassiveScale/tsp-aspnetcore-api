/**
 * @module controllers
 *
 * Collects HTTP service operations from a compiled TypeSpec program and
 * organises them into {@link ControllerGroup} records, each of which describes
 * one controller / service pair ready for template rendering.
 *
 * The main export is {@link collectControllers}, called by the emitter after
 * all models and enums have been processed.
 */

import {
  Interface,
  ModelProperty,
  Namespace,
  Program,
  Type,
  getDoc,
  getFormat,
  isArrayModelType,
  isRecordModelType,
} from "@typespec/compiler";
import {
  HttpOperation,
  HttpOperationParameter,
  HttpPayloadBody,
  getAllHttpServices,
  getRoutePath,
} from "@typespec/http";
import {
  Availability,
  getAllVersions,
  getAvailabilityMap,
  Version,
} from "@typespec/versioning";
import {
  ControllerView,
  OperationParamView,
  OperationView,
  ServiceView,
  renderDocComment,
} from "./renderer.js";

/** Maps TypeSpec `@format` values to their C# type equivalents. */
const FORMAT_MAP: Record<string, string> = {
  uuid: "Guid",
  guid: "Guid",
  uri: "Uri",
  url: "Uri",
  "date-time": "DateTimeOffset",
  date: "DateOnly",
  time: "TimeOnly",
};

/** Maps TypeSpec built-in scalar names to their C# primitive equivalents. */
const SCALAR_MAP: Record<string, string> = {
  string: "string",
  boolean: "bool",
  bytes: "byte[]",
  int8: "sbyte",
  int16: "short",
  int32: "int",
  int64: "long",
  uint8: "byte",
  uint16: "ushort",
  uint32: "uint",
  uint64: "ulong",
  safeint: "long",
  integer: "long",
  float: "double",
  float32: "float",
  float64: "double",
  decimal: "decimal",
  decimal128: "decimal",
  numeric: "double",
  plainDate: "DateOnly",
  plainTime: "TimeOnly",
  utcDateTime: "DateTimeOffset",
  offsetDateTime: "DateTimeOffset",
  duration: "TimeSpan",
  url: "Uri",
};

/**
 * Options forwarded from the emitter to the controller collection phase.
 * These mirror the subset of {@link ResolvedOptions} that affects routing and
 * naming.
 */
export interface ControllerOptions {
  /** Route prefix prepended to every generated route string. */
  routePrefix: string;
  /** When `true`, all properties are treated as nullable C# types. */
  nullableProperties: boolean;
  /** Suffix appended to generated abstract class names, e.g. `"Base"`. */
  abstractSuffix: string;
}

/**
 * A self-contained bundle of everything the emitter needs to write one
 * controller file and its companion service-interface file.
 */
export interface ControllerGroup {
  /** View model for the abstract ASP.NET Core controller class. */
  controllerView: ControllerView;
  /** View model for the service interface. */
  serviceView: ServiceView;
  /** Resolved C# namespace for the generated files. */
  namespace: string;
  /** Folder path segments derived from the namespace under the output root. */
  folder: string[];
  /** Original TypeSpec container name (Interface or Namespace name). */
  containerName: string;
  /** TypeSpec types referenced by operations (for building using directives). */
  references: Type[];
}

/** Union of the TypeSpec node kinds that can group HTTP operations. */
type OperationContainer = Interface | Namespace;

/**
 * Walks all HTTP services in the compiled TypeSpec program and returns one
 * {@link ControllerGroup} per logical operation container (TypeSpec Interface
 * or Namespace).
 *
 * @param program - The compiled TypeSpec program.
 * @param options - Routing and naming options forwarded from the emitter.
 * @param resolveNamespace - Callback that converts a TypeSpec Namespace node to
 *   a C# namespace string.
 * @param toFolderSegments - Callback that converts a C# namespace string to the
 *   relative folder path segments used when writing files.
 * @returns Array of controller groups, empty if any HTTP diagnostic errors are
 *   present in the program.
 */
export function collectControllers(
  program: Program,
  options: ControllerOptions,
  resolveNamespace: (ns: Namespace | undefined) => string,
  toFolderSegments: (ns: string) => string[],
): ControllerGroup[] {
  const [services, diagnostics] = getAllHttpServices(program);
  if (diagnostics.length > 0) return [];

  const groups: ControllerGroup[] = [];

  for (const service of services) {
    const versions = getAllVersions(program, service.namespace) ?? [];

    const byContainer = new Map<OperationContainer, HttpOperation[]>();
    for (const op of service.operations) {
      const container = op.container as OperationContainer;
      if (!byContainer.has(container)) byContainer.set(container, []);
      byContainer.get(container)!.push(op);
    }

    for (const [container, ops] of byContainer) {
      const containerName = container.name;
      if (!containerName) continue;

      const ns = resolveNamespace(
        container.kind === "Interface" ? container.namespace : container,
      );
      const folder = toFolderSegments(ns);
      const doc = getDoc(program, container);

      const controllerName = `${pascalCase(containerName)}Controller${options.abstractSuffix}`;
      const serviceName = `${pascalCase(containerName)}Service${options.abstractSuffix}`;
      const serviceInterfaceName = `I${pascalCase(containerName)}Service`;

      const operations = ops.map((op) =>
        buildOperationView(program, op, options, versions),
      );

      const references = collectOperationReferences(program, ops);

      groups.push({
        controllerView: {
          doc: doc ? renderDocComment(doc) : undefined,
          controllerName,
          serviceName,
          serviceInterfaceName,
          operations,
        },
        serviceView: {
          doc: doc ? renderDocComment(doc) : undefined,
          serviceName,
          interfaceName: serviceInterfaceName,
          operations,
        },
        namespace: ns,
        folder,
        containerName,
        references,
      });
    }
  }

  return groups;
}

/**
 * Collects all TypeSpec types referenced by a group of HTTP operations.
 *
 * @param program - The compiled TypeSpec program.
 * @param operations - Array of HTTP operations.
 * @returns Array of TypeSpec type nodes referenced by the operations.
 */
function collectOperationReferences(
  program: Program,
  operations: HttpOperation[],
): Type[] {
  const references = new Set<Type>();

  for (const op of operations) {
    // Collect parameter types
    for (const param of op.parameters.parameters) {
      references.add(param.param.type);
    }

    // Collect request body type
    if (op.parameters.body?.bodyKind === "single") {
      references.add(op.parameters.body.type);
    }

    // Collect response body types
    for (const response of op.responses) {
      for (const content of response.responses) {
        if (content.body?.bodyKind === "single") {
          references.add(content.body.type);
        }
      }
    }
  }

  return [...references];
}

/**
 * Filters service-level versions down to the versions where a specific
 * operation exists.
 *
 * @param program - The compiled TypeSpec program.
 * @param op - The operation being emitted.
 * @param serviceVersions - Version values declared for the containing service.
 * @returns Version values where the operation is available.
 */
function getOperationVersions(
  program: Program,
  op: HttpOperation,
  serviceVersions: Version[],
): Version[] {
  if (serviceVersions.length === 0) return [];

  const availability = getAvailabilityMap(program, op.operation);
  if (!availability) return serviceVersions;

  return serviceVersions.filter((version) => {
    const state = availability.get(version.name);
    return (
      state === Availability.Added ||
      state === Availability.Available
    );
  });
}

/**
 * Builds absolute route strings for a single operation.
 *
 * One route is emitted per available API version; a single unversioned route
 * is emitted when the service has no `@versioned` decorator. Routes are based
 * on the operation's resolved full path, preserving path parameters.
 *
 * @param prefix - Route prefix (e.g. `"api"`), may be empty.
 * @param operationPath - Full operation path as resolved by TypeSpec HTTP.
 * @param versions - Version value strings where the operation is available.
 * @returns Array of absolute route strings starting with `/`.
 */
function buildOperationRoutes(
  prefix: string,
  operationPath: string,
  versions: Version[],
): string[] {
  const trimmedPath = operationPath.replace(/^\/+|\/+$/g, "");
  const trimmedPrefix = prefix.replace(/^\/|\/$/g, "");

  if (versions.length === 0) {
    const parts = [trimmedPrefix, trimmedPath].filter(Boolean);
    return ["/" + parts.join("/")];
  }

  return versions.map((v) => {
    const parts = [trimmedPrefix, v.value, trimmedPath].filter(Boolean);
    return "/" + parts.join("/");
  });
}

/**
 * Converts a single {@link HttpOperation} into an {@link OperationView} that
 * the renderer can consume.
 *
 * @param program - The compiled TypeSpec program.
 * @param op - The HTTP operation to convert.
 * @param options - Naming, routing, and nullability options.
 * @param serviceVersions - Versions from `@versioned(Versions)`; empty
 *   when the service is unversioned.
 * @returns Populated operation view model.
 */
function buildOperationView(
  program: Program,
  op: HttpOperation,
  options: ControllerOptions,
  serviceVersions: Version[],
): OperationView {
  const opRoute = getRoutePath(program, op.operation)?.path;
  const routeSuffix =
    opRoute && opRoute !== "/" ? opRoute.replace(/^\//, "") : undefined;

  const doc = getDoc(program, op.operation);
  const params = buildParams(
    program,
    op.parameters.parameters,
    op.parameters.body,
    options,
  );
  const returnType = resolveReturnType(program, op, options);
  const versions = getOperationVersions(program, op, serviceVersions);
  const routes = buildOperationRoutes(
    options.routePrefix,
    op.path,
    versions,
  );

  return {
    doc: doc ? renderDocComment(doc) : undefined,
    name: pascalCase(op.operation.name),
    httpVerb: pascalCase(op.verb),
    routes,
    routeSuffix,
    params,
    returnType,
  };
}

/**
 * Builds the parameter list for an operation, combining path/query/header
 * parameters with the optional request body.
 *
 * @param program - The compiled TypeSpec program.
 * @param parameters - Typed HTTP parameter list (path, query, header).
 * @param body - Optional request body descriptor.
 * @param options - Nullability options.
 * @returns Ordered array of parameter view models (body always last if present).
 */
function buildParams(
  program: Program,
  parameters: HttpOperationParameter[],
  body: HttpPayloadBody | undefined,
  options: ControllerOptions,
): OperationParamView[] {
  const result: OperationParamView[] = [];

  for (const param of parameters) {
    const binding = httpParamBinding(param.type);
    if (!binding) continue;
    const prop = param.param;
    result.push({
      name: camelCase(prop.name),
      type: propTypeRef(program, prop, options),
      binding,
      optional: prop.optional,
    });
  }

  if (body && body.bodyKind === "single") {
    result.push({
      name: "body",
      type: typeRef(program, body.type, options),
      binding: "FromBody",
      optional: false,
    });
  }

  return result;
}

/**
 * Maps a TypeSpec HTTP parameter location to the corresponding ASP.NET Core
 * binding attribute name.
 *
 * @param location - TypeSpec HTTP parameter type string.
 * @returns Binding attribute name, or `undefined` for unsupported locations.
 */
function httpParamBinding(
  location: HttpOperationParameter["type"],
): OperationParamView["binding"] | undefined {
  switch (location) {
    case "path":
      return "FromRoute";
    case "query":
      return "FromQuery";
    case "header":
      return "FromHeader";
    default:
      return undefined;
  }
}

/**
 * Determines the C# return type for an HTTP operation by inspecting the first
 * 2xx response body type.
 *
 * Falls back to `"object"` when no successful response has a typed body.
 *
 * @param program - The compiled TypeSpec program.
 * @param op - The HTTP operation to inspect.
 * @param options - Nullability and type-resolution options.
 * @returns C# type string for the service method's return type.
 */
function resolveReturnType(
  program: Program,
  op: HttpOperation,
  options: ControllerOptions,
): string {
  for (const response of op.responses) {
    const code = response.statusCodes;
    const is2xx =
      code === "*" ||
      (typeof code === "number" && code >= 200 && code < 300) ||
      (typeof code === "object" && code.start >= 200 && code.end < 300);
    if (!is2xx) continue;

    for (const content of response.responses) {
      if (content.body?.bodyKind === "single") {
        return typeRef(program, content.body.type, options);
      }
    }
  }
  return "object";
}

/**
 * Resolves the C# type for a model property, taking `@format` annotations into
 * account before falling back to the raw type resolution.
 *
 * @param program - The compiled TypeSpec program.
 * @param prop - The model property to resolve.
 * @param options - Options (currently unused here but kept for consistency).
 * @returns C# type string.
 */
function propTypeRef(
  program: Program,
  prop: ModelProperty,
  options: ControllerOptions,
): string {
  const propFormat = getFormat(program, prop);
  const scalarFormat =
    prop.type.kind === "Scalar" ? getFormat(program, prop.type) : undefined;
  const format = propFormat ?? scalarFormat;
  if (format && FORMAT_MAP[format.toLowerCase()]) {
    return FORMAT_MAP[format.toLowerCase()];
  }
  return typeRef(program, prop.type, options);
}

/**
 * Recursively resolves the C# type string for any TypeSpec {@link Type} node.
 *
 * Handles scalars (via {@link SCALAR_MAP} and {@link FORMAT_MAP}), arrays,
 * records, enums, booleans, strings, numbers, nullable unions, and falls back
 * to `"object"` for unsupported kinds.
 *
 * @param program - The compiled TypeSpec program (used for `@format` lookup).
 * @param type - The TypeSpec type node to resolve.
 * @param options - Options (currently unused; kept for future extensibility).
 * @returns C# type string.
 */
function typeRef(
  program: Program,
  type: Type,
  options: ControllerOptions,
): string {
  switch (type.kind) {
    case "Scalar": {
      const format = getFormat(program, type);
      if (format && FORMAT_MAP[format.toLowerCase()])
        return FORMAT_MAP[format.toLowerCase()];
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
        return `IList<${typeRef(program, type.indexer.value, options)}>`;
      }
      if (isRecordModelType(type)) {
        return `IDictionary<string, ${typeRef(program, type.indexer.value, options)}>`;
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
      if (nonNull.length === 1)
        return typeRef(program, nonNull[0].type, options);
      return "object";
    }
    default:
      return "object";
  }
}

/**
 * Converts a string to PascalCase by splitting on `_`, `-`, and whitespace.
 *
 * @param name - Input string.
 * @returns PascalCase string.
 */
function pascalCase(name: string): string {
  if (!name) return name;
  return name
    .split(/[_\-\s]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("");
}

/**
 * Converts a string to camelCase by PascalCasing it then lowercasing the first
 * character.
 *
 * @param name - Input string.
 * @returns camelCase string.
 */
function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}
