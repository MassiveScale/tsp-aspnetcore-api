/**
 * @module validate
 *
 * The library's `$onValidate` hook, which the compiler runs once the program
 * is checked, before any emitter.
 */

import type { Program } from "@typespec/compiler";
import { validatePatchStrategies } from "./decorators.js";

/**
 * Reports problems that can only be seen once every type exists, such as a
 * decorator whose copies on derived or transformed models must be ignored.
 */
export function $onValidate(program: Program): void {
  validatePatchStrategies(program);
}
