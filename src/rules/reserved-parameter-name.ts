/**
 * @module rules/reserved-parameter-name
 *
 * Linter rule that flags HTTP operation parameters (path, query, or header)
 * whose emitted C# identifier collides with a reserved C# keyword.
 */

import { createRule, paramMessage } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import { CSHARP_RESERVED_KEYWORDS } from "../decorators.js";
import { camelCase } from "../utils.js";

/**
 * Flags a path/query/header parameter whose camelCased name is a bare C#
 * reserved keyword. The request body parameter is never at risk: it is
 * always emitted as the fixed literal identifier `"body"`, so it is
 * excluded from this check.
 */
export const reservedParameterNameRule = createRule({
  name: "reserved-parameter-name",
  severity: "warning",
  description:
    "Checks that HTTP operation parameter names do not collide with reserved C# keywords.",
  url: "https://github.com/massivescale/tsp-aspnetcore-api/blob/main/docs/rules/reserved-parameter-name.md",
  messages: {
    default: paramMessage`Parameter "${"name"}" is a reserved C# keyword; the generated controller method will declare it verbatim ("${"candidate"}") and fail to compile. Rename the parameter, or apply @serverName to override the emitted identifier.`,
  },
  create(context) {
    return {
      root: (program) => {
        const [services] = getAllHttpServices(program);

        for (const service of services) {
          for (const op of service.operations) {
            for (const param of op.parameters.parameters) {
              if (
                param.type !== "path" &&
                param.type !== "query" &&
                param.type !== "header"
              ) {
                continue;
              }

              const candidate = camelCase(param.param.name);
              if (CSHARP_RESERVED_KEYWORDS.has(candidate)) {
                context.reportDiagnostic({
                  target: param.param,
                  format: { name: param.param.name, candidate },
                });
              }
            }
          }
        }
      },
    };
  },
});
