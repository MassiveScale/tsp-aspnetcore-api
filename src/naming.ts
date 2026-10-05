/**
 * @module naming
 *
 * Resolves the C# class name for a TypeSpec model. Every module that writes or
 * references a model class goes through {@link csharpModelName} so declarations
 * and references can never disagree.
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
 *   `PagedResult<Widget>` becomes `PagedResultWidget` and
 *   `PagedResult<Widget[]>` becomes `PagedResultWidgetList`.
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
      return arg.name
        ? csharpModelName(program, arg).replace(/^@/, "")
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
