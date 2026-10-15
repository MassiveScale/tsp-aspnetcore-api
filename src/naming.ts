/**
 * @module naming
 *
 * Resolves the C# class name for a TypeSpec model. Every module that writes or
 * references a model class goes through {@link csharpModelName} so declarations
 * and references can never disagree, and through {@link qualifyTypeName} so
 * every reference is qualified the same way.
 */

import {
  type EnumMember,
  type IndeterminateEntity,
  Model,
  type ModelProperty,
  Program,
  type Type,
  type Value,
  getFriendlyName,
  isArrayModelType,
  isRecordModelType,
  isTemplateInstance,
} from "@typespec/compiler";
import { CSHARP_RESERVED_KEYWORDS, getServerName } from "./decorators.js";
import { classProperties, memoize } from "./payloads.js";
import { pascalCase } from "./utils.js";

/**
 * Returns the C# class name for a model (without namespace).
 *
 * - Plain models: the `@serverName` override, else the PascalCased TypeSpec name.
 * - Template instances (`PagedResult<Widget>`): one distinct class per
 *   instantiation. `@friendlyName` wins when present; otherwise the template's
 *   name (or `@serverName`) is suffixed with each template argument's name, so
 *   `PagedResult<Widget>` becomes `PagedResultWidget`,
 *   `PagedResult<Widget[]>` becomes `PagedResultWidgetList`, and an anonymous
 *   argument is named by its properties (`Box<{ id: string }>` → `BoxId`).
 *
 * Models declared with `is` (`model WidgetList is PagedResult<Widget>`) are not
 * template instances and keep their own name.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model to name.
 * @returns The C# class identifier, possibly `@`-prefixed when `@serverName`
 *   supplied a verbatim identifier.
 */
export function csharpModelName(program: Program, model: Model): string {
  const serverName = getServerName(program, model);
  if (!isTemplateInstance(model)) return serverName ?? pascalCase(model.name);

  const friendlyName = getFriendlyName(program, model);
  if (friendlyName) return sanitizeIdentifier(pascalCase(friendlyName));

  const args = model.templateMapper?.args ?? [];
  const suffix = args.map((arg) => templateArgumentName(program, arg)).join("");
  return `${serverName ?? pascalCase(model.name)}${sanitizeIdentifier(suffix)}`;
}

/**
 * Type names exported by the namespaces that generated files import (`System`,
 * `System.Collections.Generic`, `System.Threading`, `System.Threading.Tasks`,
 * `Microsoft.AspNetCore.Mvc`, `Microsoft.AspNetCore.Http`, `FluentValidation`,
 * `Microsoft.Extensions.DependencyInjection`, `System.Text.Json`, and the
 * implicit usings of the ASP.NET Core SDK). A generated type with one of these
 * names would be an ambiguous reference (CS0104) when written unqualified, so
 * {@link qualifyTypeName} always writes it with its namespace.
 */
const AMBIGUOUS_SHORT_NAMES: ReadonlySet<string> = new Set([
  "Action",
  "ActionResult",
  "Activator",
  "Array",
  "Attribute",
  "Barrier",
  "Boolean",
  "Buffer",
  "Byte",
  "CancellationToken",
  "Char",
  "Comparer",
  "Console",
  "ContentResult",
  "Controller",
  "ControllerBase",
  "Convert",
  "DateOnly",
  "DateTime",
  "DateTimeOffset",
  "Decimal",
  "Delegate",
  "Dictionary",
  "Directory",
  "Double",
  "Endpoint",
  "Enum",
  "Environment",
  "Exception",
  "File",
  "FileResult",
  "Func",
  "Guid",
  "Half",
  "HashSet",
  "HttpClient",
  "HttpContext",
  "HttpRequest",
  "HttpResponse",
  "Index",
  "Int16",
  "Int32",
  "Int64",
  "Interlocked",
  "JsonDocument",
  "JsonElement",
  "JsonResult",
  "JsonSerializer",
  "KeyValuePair",
  "Lazy",
  "LinkedList",
  "List",
  "Lock",
  "Math",
  "Memory",
  "Monitor",
  "Mutex",
  "Nullable",
  "Object",
  "ObjectResult",
  "Parallel",
  "Path",
  "PriorityQueue",
  "ProblemDetails",
  "Progress",
  "Queue",
  "Random",
  "Range",
  "Results",
  "Semaphore",
  "ServiceCollection",
  "ServiceDescriptor",
  "ServiceLifetime",
  "ServiceProvider",
  "Severity",
  "Single",
  "SortedDictionary",
  "SortedList",
  "SortedSet",
  "Span",
  "Stack",
  "StatusCodes",
  "Stream",
  "String",
  "Task",
  "TaskStatus",
  "Thread",
  "TimeOnly",
  "TimeSpan",
  "TimeZoneInfo",
  "Timer",
  "Tuple",
  "Type",
  "Uri",
  "ValidationContext",
  "ValidationFailure",
  "ValidationProblemDetails",
  "ValidationResult",
  "ValueTask",
  "Version",
  "Volatile",
]);

/**
 * Returns the identifier used to reference a generated type from another file.
 *
 * With `fully-qualified-types: true` the namespace is always included. Otherwise
 * the short name is returned (the referencing file imports the namespace),
 * except for names in {@link AMBIGUOUS_SHORT_NAMES}, which keep their namespace
 * so they cannot collide with a framework type of the same name.
 *
 * @param namespace - The C# namespace the type is declared in.
 * @param typeName - The C# type identifier, possibly `@`-prefixed.
 * @param options - The `fullyQualifiedTypes` setting.
 * @returns The type reference to write into generated code.
 */
export function qualifyTypeName(
  namespace: string,
  typeName: string,
  options: { fullyQualifiedTypes: boolean },
): string {
  if (!namespace) return typeName;
  if (options.fullyQualifiedTypes || isAmbiguousShortName(typeName)) {
    return `${namespace}.${typeName}`;
  }
  return typeName;
}

/**
 * Returns `true` when an unqualified reference to `typeName` would clash with
 * a framework type imported by generated files.
 *
 * @param typeName - The C# type identifier, possibly `@`-prefixed.
 */
export function isAmbiguousShortName(typeName: string): boolean {
  return AMBIGUOUS_SHORT_NAMES.has(typeName.replace(/^@/, ""));
}

/**
 * Converts a single template argument to the name fragment appended to a
 * template instance's class name.
 *
 * @param program - The compiled TypeSpec program.
 * @param arg - The template argument.
 * @returns A PascalCase fragment, or an empty string for argument kinds that
 *   have no meaningful name (values, intrinsics).
 */
function templateArgumentName(
  program: Program,
  arg: Type | Value | IndeterminateEntity,
): string {
  if (arg.entityKind === "Indeterminate") {
    return templateArgumentName(program, arg.type);
  }
  if (arg.entityKind !== "Type") return "";
  switch (arg.kind) {
    case "Model":
      if (isArrayModelType(arg)) {
        return `${templateArgumentName(program, arg.indexer.value)}List`;
      }
      if (isRecordModelType(arg)) {
        return `${templateArgumentName(program, arg.indexer.value)}Map`;
      }
      if (arg.name) return csharpModelName(program, arg).replace(/^@/, "");
      // Anonymous models are named by their properties so `Box<{ id: string }>`
      // and `Box<{ name: string }>` stay distinct; any remaining clash is
      // reported as `duplicate-model-name` rather than silently overwritten.
      return arg.properties.size > 0
        ? [...arg.properties.keys()].map(pascalCase).join("")
        : "Object";
    case "Scalar":
    case "Enum":
      return pascalCase(arg.name);
    case "Union":
      return arg.name
        ? pascalCase(arg.name)
        : [...arg.variants.values()]
            .map((variant) => templateArgumentName(program, variant.type))
            .join("Or");
    case "String":
      return pascalCase(arg.value);
    case "Number":
    case "Boolean":
      return pascalCase(String(arg.value));
    default:
      return "";
  }
}

/** Identifier used for a name that has no letters or digits at all (e.g. `""`). */
const EMPTY_IDENTIFIER = "Empty";

/**
 * Suffix appended to a property whose identifier equals its class name, since
 * C# forbids a member named after its enclosing type (CS0542).
 */
const CLASS_NAME_COLLISION_SUFFIX = "Value";

/**
 * Converts arbitrary TypeSpec text (a property name, an enum member name or a
 * string literal) to a PascalCase C# identifier.
 *
 * Every run of characters that is not a letter or digit separates words, so
 * `user_id`, `user-id` and `user.id` all become `UserId`. A leading digit gets a
 * `_` prefix, and text with no letters or digits becomes `Empty`. The result
 * starts with an upper-case letter, a `_`, or a caseless letter, so it can never
 * be a (lower-case) C# keyword.
 *
 * @param name - The raw name.
 * @returns A valid C# identifier.
 */
export function csharpIdentifier(name: string): string {
  const pascal = name
    .split(/[^\p{L}\p{Nd}]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  if (!pascal) return EMPTY_IDENTIFIER;
  return /^\p{Nd}/u.test(pascal) ? `_${pascal}` : pascal;
}

/**
 * Converts arbitrary TypeSpec text to a camelCase C# parameter identifier,
 * `@`-escaping it when it is a C# keyword (`class` becomes `@class`).
 *
 * @param name - The raw name.
 * @returns A valid C# identifier.
 */
export function csharpParameterIdentifier(name: string): string {
  const pascal = csharpIdentifier(name);
  const camel = pascal[0].toLowerCase() + pascal.slice(1);
  return CSHARP_RESERVED_KEYWORDS.has(camel) ? `@${camel}` : camel;
}

/**
 * Returns `candidate`, or `candidate` followed by the smallest number from 2
 * upward that is not yet in `taken`, and records the result in `taken`. Names
 * are compared without a leading `@`, since `@class` and `class` are the same
 * C# identifier.
 *
 * @param candidate - The preferred identifier.
 * @param taken - Identifiers already in use in the same scope; updated in place.
 * @returns A unique identifier.
 */
export function uniqueIdentifier(
  candidate: string,
  taken: Set<string>,
): string {
  const bare = (name: string) => name.replace(/^@/, "");
  let name = candidate;
  for (let i = 2; taken.has(bare(name)); i++) name = `${candidate}${i}`;
  taken.add(bare(name));
  return name;
}

/**
 * Returns the C# identifiers of a list of enum member names (or inferred-enum
 * string values), in the same order. Names that collide after conversion
 * (`a-b` and `aB`) get a numeric suffix.
 *
 * @param names - Raw member names in declaration order.
 * @returns One unique C# identifier per name.
 */
export function enumMemberIdentifiers(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => uniqueIdentifier(csharpIdentifier(name), taken));
}

/**
 * Returns the C# identifier of a single member of a TypeSpec enum, consistent
 * with {@link enumMemberIdentifiers} over the whole enum.
 *
 * @param member - The enum member.
 * @returns The member's C# identifier.
 */
export function enumMemberIdentifier(member: EnumMember): string {
  const members = [...member.enum.members.values()];
  return enumMemberIdentifiers(members.map((m) => m.name))[
    members.indexOf(member)
  ];
}

/**
 * Returns the C# property identifier of every class property of a model (see
 * {@link classProperties}). Every module that declares or references a model
 * property goes through this, so declarations and references agree.
 *
 * - `@serverName` is used verbatim and reserved before any other name.
 * - Other names go through {@link csharpIdentifier}.
 * - A name equal to the class name gets a `Value` suffix (CS0542).
 * - Names that collide after conversion (`user_id` and `userId`) get a numeric suffix.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model that owns the class.
 * @returns Map from each class property to its C# identifier.
 */
export function propertyIdentifiers(
  program: Program,
  model: Model,
): ReadonlyMap<ModelProperty, string> {
  return memoize(propertyIdentifiersCache, program, model, () =>
    computePropertyIdentifiers(program, model),
  );
}

/** Per-program cache of {@link propertyIdentifiers} results. */
const propertyIdentifiersCache = new WeakMap<
  Program,
  WeakMap<Model, ReadonlyMap<ModelProperty, string>>
>();

function computePropertyIdentifiers(
  program: Program,
  model: Model,
): Map<ModelProperty, string> {
  const className = csharpModelName(program, model).replace(/^@/, "");
  const properties = classProperties(program, model);
  const taken = new Set<string>();
  for (const prop of properties) {
    const serverName = getServerName(program, prop);
    if (serverName) taken.add(serverName.replace(/^@/, ""));
  }

  const result = new Map<ModelProperty, string>();
  for (const prop of properties) {
    const serverName = getServerName(program, prop);
    if (serverName) {
      result.set(prop, serverName);
      continue;
    }
    let candidate = csharpIdentifier(prop.name);
    if (candidate === className) candidate += CLASS_NAME_COLLISION_SUFFIX;
    result.set(prop, uniqueIdentifier(candidate, taken));
  }
  return result;
}

/**
 * Returns the C# property identifier of a property of `model`, consistent with
 * {@link propertyIdentifiers}. An inherited property is looked up on the base
 * class that declares it, so a derived validator references the identifier the
 * base class actually declares (e.g. `ItemValue`, `UserId2`).
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The model whose class (or an ancestor's) declares `prop`.
 * @param prop - A class property of `model` or of one of its base models.
 * @returns The property's C# identifier.
 */
export function propertyIdentifier(
  program: Program,
  model: Model,
  prop: ModelProperty,
): string {
  for (
    let current: Model | undefined = model;
    current;
    current = current.baseModel
  ) {
    const identifier = propertyIdentifiers(program, current).get(prop);
    if (identifier) return identifier;
  }
  return getServerName(program, prop) ?? csharpIdentifier(prop.name);
}

/**
 * Removes characters that are not legal in a C# identifier.
 *
 * @param name - Candidate identifier text.
 * @returns The text with every character other than letters, digits and `_` removed.
 */
function sanitizeIdentifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "");
}
