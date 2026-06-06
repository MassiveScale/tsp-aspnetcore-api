/**
 * @module decorators
 *
 * TypeScript implementations for the decorators declared in `lib/decorators.tsp`.
 */

import type {
  DecoratorContext,
  DecoratorImplementations,
  Enum,
  EnumMember,
  Model,
  ModelProperty,
  Program,
} from "@typespec/compiler";
import { $lib } from "./lib.js";

const serverNameKey = $lib.createStateSymbol("serverName");

function serverNameImpl(
  context: DecoratorContext,
  target: Model | Enum | EnumMember | ModelProperty,
  name: string,
): void {
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
 * Returns the `@serverName` override for a model or enum, or `undefined` if
 * the decorator was not applied.
 */
export function getServerName(
  program: Program,
  target: Model | Enum | EnumMember | ModelProperty,
): string | undefined {
  return program.stateMap(serverNameKey).get(target) as string | undefined;
}
