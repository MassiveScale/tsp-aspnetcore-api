/**
 * @module @massivescale/tsp-aspnetcore-api
 *
 * TypeSpec emitter that generates C# model classes, interfaces, enums,
 * controllers, and services from a TypeSpec program.
 *
 * Entry point consumed by the TypeSpec compiler via the `emit` field in
 * `tspconfig.yaml`.  The two named exports below are the only symbols the
 * compiler calls directly.
 */

export { $onEmit } from "./emitter.js";
export { $lib } from "./lib.js";
