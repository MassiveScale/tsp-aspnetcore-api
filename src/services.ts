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
      usings: buildServiceUsings(options),
      body: renderer.renderServiceInterface(group.serviceView),
    }),
  });
}

/**
 * Builds the sorted list of `using` namespaces for a generated service interface file.
 *
 * Model, enum, and helper (`MergePatch<T>`) references are always emitted as
 * fully-qualified type names, so this only needs {@link SERVICE_USINGS} plus
 * any `additional-usings` from options.
 *
 * @param options - Resolved emitter options (additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function buildServiceUsings(options: ResolvedOptions): string[] {
  const usings = new Set<string>(SERVICE_USINGS);
  if (options.cancellationToken) usings.add("System.Threading");
  for (const u of options.additionalUsings) usings.add(u);
  return sortUsings(usings);
}
