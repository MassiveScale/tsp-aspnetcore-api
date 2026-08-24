/**
 * @module linter
 *
 * Linter rule and rule-set registration for the emitter, discovered by the
 * TypeSpec compiler via the `$linter` export.
 */

import { defineLinter } from "@typespec/compiler";
import { reservedParameterNameRule } from "./rules/reserved-parameter-name.js";

export const $linter = defineLinter({
  rules: [reservedParameterNameRule],
  ruleSets: {
    recommended: {
      enable: {
        "@massivescale/tsp-aspnetcore-api/reserved-parameter-name": true,
      },
    },
    all: {
      enable: {
        "@massivescale/tsp-aspnetcore-api/reserved-parameter-name": true,
      },
    },
  },
});
