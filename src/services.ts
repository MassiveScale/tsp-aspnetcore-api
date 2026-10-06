/**
 * @module services
 *
 * Emits the service-interface file for each {@link ControllerGroup} collected
 * from the compiled TypeSpec program's HTTP operations.
 *
 * The main export is {@link emitService}, called by the emitter once per
 * controller group when `emit-services` is `true`.
 */

import { Program, emitFile, resolvePath } from "@typespec/compiler";
import { ControllerGroup } from "./controllers.js";
import { ResolvedOptions, sortUsings } from "./emitter.js";
import { Renderer } from "./renderer.js";

/** `using` directives included in every service interface file. */
const SERVICE_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Threading.Tasks",
];

/**
 * Writes the service-interface file for one {@link ControllerGroup}.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param group - The controller group to emit.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options (for output paths and extension).
 */
export async function emitService(
  program: Program,
  group: ControllerGroup,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const serviceInterfaceFileName = `${group.serviceView.interfaceName}${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.servicesOutputDir, serviceInterfaceFileName),
    content: renderer.renderFile({
      fileName: serviceInterfaceFileName,
      namespace: options.servicesNamespace,
      usings: buildServiceUsings(options, group),
      body: renderer.renderServiceInterface(group.serviceView),
    }),
  });
}

/**
 * Builds the sorted list of `using` namespaces for a generated service interface file.
 *
 * Adds model and helper namespaces when short type names are enabled, plus
 * {@link SERVICE_USINGS} and any `additional-usings` from options.
 *
 * @param options - Resolved emitter options (additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildServiceUsings(
  options: ResolvedOptions,
  group: ControllerGroup,
): string[] {
  const usings = new Set<string>(SERVICE_USINGS);
  if (options.cancellationToken) usings.add("System.Threading");
  if (!options.fullyQualifiedTypes) {
    usings.add(options.modelsNamespace);
    if (
      options.mergePatchStyle === "generic" &&
      group.serviceView.operations.some((operation) =>
        operation.params.some((param) => param.type.includes("MergePatch<")),
      ) &&
      options.helpersNamespace !== options.servicesNamespace
    ) {
      usings.add(options.helpersNamespace);
    }
  }
  for (const u of options.additionalUsings) usings.add(u);
  return sortUsings(usings);
}
