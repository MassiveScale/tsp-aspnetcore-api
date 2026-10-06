/**
 * @module naming
 *
 * Resolves the C# class name for a TypeSpec model. Every module that writes or
 * references a model class goes through {@link csharpModelName} so declarations
 * and references can never disagree, and through {@link qualifyTypeName} so
 * every reference is qualified the same way.
 */

import {
  type IndeterminateEntity,
  Model,
  Program,
  type Type,
  type Value,
  getFriendlyName,
  isArrayModelType,
  isRecordModelType,
  isTemplateInstance,
} from "@typespec/compiler";
import { getServerName } from "./decorators.js";
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

/**
 * Removes characters that are not legal in a C# identifier.
 *
 * @param name - Candidate identifier text.
 * @returns The text with every character other than letters, digits and `_` removed.
 */
function sanitizeIdentifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "");
}
