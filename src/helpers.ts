/**
 * @module helpers
 *
 * Emits the runtime helper classes referenced by generated models and
 * services: the shared generic `MergePatch<T>` helper (or, when
 * `merge-patch-style` is `"typed"`, one `{Model}MergePatchUpdate` class per
 * PATCH-able entity) and the optional `EnumMemberConverter` JSON converter.
 *
 * The main export is {@link emitHelpers}, called by the emitter after models
 * and enums have been emitted.
 */

import { Model, Program, emitFile, resolvePath } from "@typespec/compiler";
import { getServerName } from "./decorators.js";
import {
  computeModelFqName,
  csharpNamespaceFor,
  folderSegments,
  ResolvedOptions,
  sortUsings,
} from "./emitter.js";
import { Renderer } from "./renderer.js";
import { pascalCase } from "./utils.js";
import { collectValidatorModelsFromRoutes } from "./validators.js";

/** `using` directives included in the MergePatch helper file. */
const MERGE_PATCH_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Reflection",
  "System.Text.Json",
  "System.Text.Json.Serialization",
  "System.Threading",
  "System.Threading.Tasks",
];

/** `using` directives included in the EnumMemberConverter helper file. */
const ENUM_CONVERTER_HELPER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Reflection",
  "System.Runtime.Serialization",
  "System.Text.Json",
  "System.Text.Json.Serialization",
];

/**
 * Emits the MergePatch support files (generic helper or per-entity typed
 * classes, depending on `merge-patch-style`) and, when `emit-helpers` is
 * enabled, the `EnumMemberConverter` helper.
 *
 * @param program - The compiled TypeSpec program.
 * @param models - Models collected by the emitter, used to discover PATCH bodies.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
export async function emitHelpers(
  program: Program,
  models: Model[],
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const patchRouteModels = collectValidatorModelsFromRoutes(program, models);

  if (options.mergePatchStyle === "typed") {
    if (patchRouteModels?.patchModels.size) {
      await emitEntityMergePatches(
        program,
        patchRouteModels.patchModels,
        renderer,
        options,
      );
    }
  } else {
    await emitMergePatch(program, renderer, options);
  }

  // Emit EnumMemberConverter helper only when emit-helpers is true (optional).
  if (options.emitHelpers) {
    await emitEnumMemberConverter(program, renderer, options);
  }
}

/**
 * Writes the shared generic `MergePatch<T>` helper class to the helpers output
 * directory. Only called when `merge-patch-style` is `"generic"` (the default).
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitMergePatch(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const mergePatchFileName = `MergePatch${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, mergePatchFileName),
    content: renderer.renderFile({
      fileName: mergePatchFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(MERGE_PATCH_USINGS)),
      body: renderer.renderMergePatch(),
    }),
  });
}

/**
 * Writes one `{ModelName}MergePatchUpdate` file per entity in `patchModels` to the
 * models output directory. Only called when `merge-patch-style` is `"typed"`.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param patchModels - Map of source models to their raw body type names.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitEntityMergePatches(
  program: Program,
  patchModels: Map<Model, string>,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  for (const [model, rawTypeName] of patchModels) {
    if (!rawTypeName.startsWith("MergePatch<")) continue;
    const modelName = getServerName(program, model) ?? pascalCase(model.name);
    const qualifiedModelName = computeModelFqName(program, model, options);
    const fileName = `${modelName}MergePatchUpdate${options.fileExtension}`;
    const typespecNs = csharpNamespaceFor(
      model.namespace,
      options,
      options.effectiveRootNamespace,
    );
    const classFolder = options.namespaceFromPath
      ? []
      : folderSegments(options.effectiveRootNamespace, typespecNs);
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...classFolder, fileName),
      content: renderer.renderFile({
        fileName,
        namespace: options.modelsNamespace,
        usings: sortUsings(new Set(MERGE_PATCH_USINGS)),
        body: renderer.renderEntityMergePatch({
          modelName,
          qualifiedModelName,
        }),
      }),
    });
  }
}

/**
 * Writes the `EnumMemberConverter` helper class to the helpers output
 * directory. This is only emitted when the `emit-helpers` option is enabled.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitEnumMemberConverter(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const enumConverterFileName = `EnumMemberConverter${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, enumConverterFileName),
    content: renderer.renderFile({
      fileName: enumConverterFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(ENUM_CONVERTER_HELPER_USINGS)),
      body: renderer.renderEnumMemberConverter(),
    }),
  });
}
