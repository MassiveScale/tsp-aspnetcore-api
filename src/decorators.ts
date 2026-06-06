/**
 * @module decorators
 *
 * TypeScript implementations for the decorators declared in `lib/decorators.tsp`.
 */

import type {
  DecoratorContext,
  DecoratorImplementations,
  Model,
  ModelProperty,
  Program,
} from "@typespec/compiler";
import { $lib, reportDiagnostic } from "./lib.js";

const serverNameKey = $lib.createStateSymbol("serverName");

/**
 * Regular expression for a valid C# identifier.
 * Accepts an optional leading `@` (used to escape reserved words),
 * followed by a letter or underscore, then any mix of letters, digits,
 * and underscores.  Rejects names with path separators, dots, spaces, or
 * other characters that would produce invalid C# or allow path traversal
 * in output filenames.
 */
const VALID_CSHARP_IDENTIFIER = /^@?[a-zA-Z_][a-zA-Z0-9_]*$/;

function serverNameImpl(
  context: DecoratorContext,
  target: Model | ModelProperty,
  name: string,
): void {
  if (!VALID_CSHARP_IDENTIFIER.test(name)) {
    reportDiagnostic(context.program, {
      code: "invalid-server-name",
      target,
      format: { name },
    });
    return;
  }
  context.program.stateMap(serverNameKey).set(target, name);
}

/**
 * Namespaced decorator export consumed by the TypeSpec compiler.
 * Binding via `$decorators` (rather than a bare `$serverName`) keeps the
 * implementation scoped to `MassiveScale.AspNetCoreApi` and avoids creating
 * a conflicting `global.serverName` symbol.
 */
export const $decorators: DecoratorImplementations = {
  "MassiveScale.AspNetCoreApi": {
    serverName: serverNameImpl,
  },
};

/**
 * Returns the `@serverName` override for a model or model
 * property, or `undefined` if the decorator was not applied.
 */
export function getServerName(
  program: Program,
  target: Model | ModelProperty,
): string | undefined {
  return program.stateMap(serverNameKey).get(target) as string | undefined;
}
