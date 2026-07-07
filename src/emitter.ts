/**
 * @module emitter
 *
 * Core TypeSpec emitter.  The exported {@link $onEmit} function is called by
 * the TypeSpec compiler for every `emit` run and is responsible for:
 *
 * 1. Resolving all user-supplied options.
 * 2. Collecting models, enums, and HTTP service operations from the compiled
 *    program.
 * 3. Delegating to {@link ./models.js}, {@link ./controllers.js},
 *    {@link ./services.js}, {@link ./helpers.js}, and {@link ./validators.js}
 *    to render each artifact through Handlebars templates and write the
 *    resulting `.g.cs` (or custom-extension) files to disk via the TypeSpec
 *    `emitFile` API.
 *
 * This module also owns the plumbing shared by every emission module:
 * resolved-options resolution, namespace/folder derivation, and renderer
 * construction.
 */

import {
  EmitContext,
  Enum,
  Model,
  Namespace,
  Program,
  getNamespaceFullName,
  isStdNamespace,
  navigateProgram,
  NoTarget,
  resolvePath,
} from "@typespec/compiler";
import { isMergePatch } from "@typespec/http/experimental/merge-patch";
import { getServerName } from "./decorators.js";
import { EmitterOptions, reportDiagnostic } from "./lib.js";
import { pascalCase } from "./utils.js";
import {
  Renderer,
  TemplateName,
  TemplateOverrides,
  createRenderer,
} from "./renderer.js";
import {
  ControllerOptions,
  collectControllers,
  emitController,
} from "./controllers.js";
import { emitService } from "./services.js";
import {
  emitModelsAndEnums,
  shouldEmitModel,
  shouldEmitEnum,
} from "./models.js";
import { emitHelpers } from "./helpers.js";
import { emitValidators } from "./validators.js";

/** Default C# namespace used for top-level TypeSpec models with no namespace. */
const DEFAULT_NAMESPACE = "Models";

/**
 * Fully-resolved emitter configuration, derived from raw {@link EmitterOptions}
 * and the `EmitContext`.  All paths are absolute; all optional fields have
 * defaults applied.
 */
export interface ResolvedOptions {
  /** Value of `root-namespace`, or `undefined` if not configured. */
  rootNamespace: string | undefined;
  /**
   * Inferred or explicitly configured global root namespace.
   * Equals `root-namespace` when set, otherwise inferred from the TypeSpec namespace tree.
   */
  effectiveRootNamespace: string | undefined;
  /** Verbatim C# namespace for all model and enum files. */
  modelsNamespace: string;
  /** Verbatim C# namespace for all interface files (always equals modelsNamespace). */
  interfacesNamespace: string;
  /** Verbatim C# namespace for all controller files. */
  controllersNamespace: string;
  /** Verbatim C# namespace for all service files. */
  servicesNamespace: string;
  /** Verbatim C# namespace for all validator files (version suffix may be appended). */
  validatorsNamespace: string;
  /** Verbatim C# namespace for all helper files. */
  helpersNamespace: string;
  /** Sorted namespace-map entries (longest key first for longest-match wins). */
  namespaceMap: Array<{ key: string; value: string }>;
  /** File extension for all emitted files, e.g. `".g.cs"`. */
  fileExtension: string;
  /** Absolute path to the models output directory. */
  modelsOutputDir: string;
  /** Whether to emit `I<Model>` interface files. */
  emitInterfaces: boolean;
  /** Absolute path to the interfaces output directory. */
  interfacesOutputDir: string;
  /** Whether to emit controller base class files. */
  emitControllers: boolean;
  /** Absolute path to the controllers output directory. */
  controllersOutputDir: string;
  /** Whether to emit service interface files. */
  emitServices: boolean;
  /** Absolute path to the services output directory. */
  servicesOutputDir: string;
  /** Route prefix prepended to every controller route. */
  routePrefix: string;
  /** Extra `using` namespaces appended to every file. */
  additionalUsings: string[];
  /** Whether to emit all properties as nullable C# types. */
  nullableProperties: boolean;
  /** Suffix appended to generated abstract class names. */
  abstractSuffix: string;
  /** Whether to add a CancellationToken parameter to operations. */
  cancellationToken: boolean;
  /** Resolved template override paths (absolute). */
  templates: TemplateOverrides;
  /** Whether to emit helper files (`MergePatchValue`, `EnumMemberConverter`). */
  emitHelpers: boolean;
  /** Absolute path to the helpers output directory. */
  helpersOutputDir: string;
  /** When `true`, model/enum/interface files are placed flat in their output dir; otherwise placed in TypeSpec-namespace-mirrored subdirectories. */
  namespaceFromPath: boolean;
  /** Whether to emit FluentValidation validator files. */
  emitValidators: boolean;
  /** Absolute path to the validators output directory. */
  validatorsOutputDir: string;
  /** Which validator type(s) to emit: "post", "patch", or "both". */
  validatorsTypes: "post" | "patch" | "both";
  /**
   * Version strategy for validator generation.
   * `undefined` means auto-detect: "version-aware" when `@versioned` is present,
   * "earliest" otherwise.
   */
  validatorsVersionStrategy:
    "earliest" | "latest" | "per-version" | "version-aware" | undefined;
  /** Whether to emit a shared generic helper or per-entity typed classes for MergePatch support. */
  mergePatchStyle: "generic" | "typed";
}

/**
 * TypeSpec emitter entry point.  Called once per emit run by the TypeSpec
 * compiler.
 *
 * Emits:
 * - One `<Model>.g.cs` and `I<Model>.g.cs` per TypeSpec model.
 * - One `<Name>.g.cs` per TypeSpec enum.
 * - One controller file and one service-interface file per HTTP operation
 *   container.
 * - MergePatch and EnumMemberConverter helper files.
 * - FluentValidation validator files, when `emit-validators` is `true`.
 *
 * @param context - Emit context provided by the TypeSpec compiler, carrying the
 *   compiled program, resolved options, and output directory path.
 */
export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  if (context.program.compilerOptions.noEmit) {
    return;
  }

  const program = context.program;
  const options = resolveOptions(context);

  const renderer = buildRenderer(program, options);
  if (!renderer) return;

  const models: Model[] = [];
  const enums: Enum[] = [];

  navigateProgram(program, {
    model(model) {
      if (shouldEmitModel(model) && !isMergePatch(program, model))
        models.push(model);
    },
    enum(en) {
      if (shouldEmitEnum(en)) enums.push(en);
    },
  });

  await emitModelsAndEnums(program, models, enums, renderer, options);

  const controllerOptions: ControllerOptions = {
    routePrefix: options.routePrefix,
    nullableProperties: options.nullableProperties,
    abstractSuffix: options.abstractSuffix,
    cancellationToken: options.cancellationToken,
    mergePatchStyle: options.mergePatchStyle,
    modelsNamespace: options.modelsNamespace,
    helpersNamespace: options.helpersNamespace,
  };

  const groups = collectControllers(
    program,
    controllerOptions,
    (ns) => csharpNamespaceFor(ns, options),
    (ns) => folderSegments(options.effectiveRootNamespace, ns),
  );

  for (const group of groups) {
    if (options.emitControllers) {
      await emitController(program, group, renderer, options);
    }
    if (options.emitServices) {
      await emitService(program, group, renderer, options);
    }
  }

  await emitHelpers(program, models, renderer, options);

  if (options.emitValidators) {
    await emitValidators(program, options);
  }
}

/**
 * Sorts a set of `using` namespace strings with `System` namespaces first,
 * then alphabetically within each group.
 *
 * @param set - Unsorted set of namespace strings.
 * @returns Sorted array of namespace strings.
 */
export function sortUsings(set: Set<string>): string[] {
  return [...set].sort((a, b) => {
    const aSystem = a === "System" || a.startsWith("System.");
    const bSystem = b === "System" || b.startsWith("System.");
    if (aSystem !== bSystem) return aSystem ? -1 : 1;
    return a.localeCompare(b);
  });
}

/**
 * Instantiates the Handlebars renderer, reporting a structured diagnostic if
 * any template cannot be loaded.
 *
 * @param program - The compiled TypeSpec program (used to report diagnostics).
 * @param options - Resolved options carrying template override paths.
 * @returns A renderer instance, or `undefined` if template loading failed.
 */
function buildRenderer(
  program: Program,
  options: ResolvedOptions,
): Renderer | undefined {
  try {
    return createRenderer(options.templates);
  } catch (err) {
    const path = findFailingTemplatePath(options.templates, err);
    const name = (Object.entries(options.templates).find(
      ([, p]) => p === path,
    )?.[0] ?? "unknown") as TemplateName;
    reportDiagnostic(program, {
      code: "template-load-failed",
      target: NoTarget,
      format: {
        name,
        path: path ?? "",
        reason: err instanceof Error ? err.message : String(err),
      },
    });
    return undefined;
  }
}

/**
 * Searches the error message of a failed template load to identify which
 * override path caused the failure.
 *
 * @param templates - Map of template name to override path.
 * @param err - The error thrown during template loading.
 * @returns The failing path string, or `undefined` if it cannot be inferred.
 */
function findFailingTemplatePath(
  templates: TemplateOverrides,
  err: unknown,
): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  for (const value of Object.values(templates)) {
    if (value && message.includes(value)) return value;
  }
  return undefined;
}

/**
 * Returns the fully-qualified C# class name for a model, using the same
 * namespace logic as class file emission (TypeSpec namespace + optional dir suffix).
 */
export function computeModelFqName(
  program: Program,
  model: Model,
  options: ResolvedOptions,
): string {
  const classNs = options.modelsNamespace;
  const className = getServerName(program, model) ?? pascalCase(model.name);
  return classNs ? `${classNs}.${className}` : className;
}

/**
 * Infers the effective root namespace from the TypeSpec program when
 * `root-namespace` is not explicitly configured.
 *
 * Collects all top-level user namespaces (direct children of the TypeSpec
 * global namespace) and, when there is exactly one, descends through any
 * single-child chains to find the deepest common ancestor — i.e. the most
 * specific namespace shared by all user-defined types.
 *
 * Examples:
 * - `namespace Demo;` → `"Demo"`
 * - `namespace My.App;` → `"My.App"`
 * - `namespace App.Models {} namespace App.Services {}` → `"App"` (common root)
 * - *(no namespace declaration)* → `undefined`
 *
 * @param program - The compiled TypeSpec program.
 * @returns The inferred root namespace string, or `undefined`.
 */
function inferRootNamespace(program: Program): string | undefined {
  // Collect direct children of the global namespace (which has no parent).
  // The global namespace node itself has ns.namespace === undefined; its direct
  // children satisfy: ns.namespace is defined AND ns.namespace.namespace is undefined.
  const topLevel: Namespace[] = [];
  navigateProgram(program, {
    namespace(ns) {
      if (!isStdNamespace(ns) && ns.namespace && !ns.namespace.namespace) {
        topLevel.push(ns);
      }
    },
  });

  // Ambiguous (multiple top-level user namespaces, e.g. across separate tsp files
  // with distinct root names) or absent — cannot infer.
  if (topLevel.length !== 1) return undefined;

  // Walk the single-child chain downward to find the most specific common root.
  function walk(ns: Namespace): Namespace {
    const children = [...ns.namespaces.values()].filter(
      (n) => !isStdNamespace(n),
    );
    // Single child: keep descending.  Zero or multiple children: this is the
    // deepest common ancestor, return it.
    return children.length === 1 ? walk(children[0]) : ns;
  }

  const result = walk(topLevel[0]);
  return getNamespaceFullName(result) || undefined;
}

/**
 * Converts raw {@link EmitterOptions} from the `EmitContext` into a
 * fully-resolved {@link ResolvedOptions} object.
 *
 * - Relative output directories are resolved against the emitter output dir.
 * - Namespace-map entries are sorted longest-key-first.
 * - All optional values receive their documented defaults.
 * - When `root-namespace` is not set, the TypeSpec namespace is inferred from
 *   the program and used as the root for controller, service, and helper
 *   path-namespace calculations.
 *
 * @param context - The TypeSpec emit context.
 * @returns Resolved options ready for use throughout the emit phase.
 */
function resolveOptions(context: EmitContext<EmitterOptions>): ResolvedOptions {
  const raw = context.options;
  const baseDir = context.emitterOutputDir;
  const map = raw["namespace-map"] ?? {};
  const namespaceMap = Object.entries(map)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.key.length - a.key.length);
  // Default output directories are "Models" for models/interfaces, and "Controllers"/"Services"/"Helpers" for others.
  // When namespace-from-path is enabled, the dir suffixes are always applied to the namespace
  // to reflect the output directory path (e.g., "MyApp.Models", "MyApp.Controllers").
  const modelsDir = raw["models-output-dir"] ?? "Models";
  const interfacesDir = raw["interfaces-output-dir"] ?? "Models";
  const controllersDir = raw["controllers-output-dir"] ?? "Controllers";
  const servicesDir = raw["services-output-dir"] ?? "Services";
  const helpersDir = raw["helpers-output-dir"] ?? "Helpers";
  const validatorsDir = raw["validators-output-dir"] ?? "Validators";
  const rootNs = raw["root-namespace"];
  // When the user does not supply root-namespace, infer it from the TypeSpec
  // namespace tree so that generated files automatically receive a
  // properly-qualified namespace (e.g. "MyApp.Controllers").
  const effectiveRootNs = rootNs ?? inferRootNamespace(context.program);
  // Determine if we should use namespace-from-path mode (controls file placement only).
  const useNamespaceFromPath = raw["namespace-from-path"] ?? false;

  // Each section has an explicit namespace option. When not set, synthesize
  // from effectiveRootNs + the conventional suffix segment.
  const modelsNamespace =
    raw["models-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Models` : "Models");
  const controllersNamespace =
    raw["controllers-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Controllers` : "Controllers");
  const servicesNamespace =
    raw["services-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Services` : "Services");
  const validatorsNamespace =
    raw["validators-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Validators` : "Validators");
  const helpersNamespace =
    raw["helpers-namespace"] ??
    (effectiveRootNs ? `${effectiveRootNs}.Helpers` : "Helpers");

  return {
    rootNamespace: rootNs,
    effectiveRootNamespace: effectiveRootNs,
    modelsNamespace,
    interfacesNamespace: modelsNamespace,
    controllersNamespace,
    servicesNamespace,
    validatorsNamespace,
    helpersNamespace,
    namespaceMap,
    fileExtension: raw["file-extension"] ?? ".g.cs",
    modelsOutputDir: resolvePath(baseDir, modelsDir),
    emitInterfaces: raw["emit-interfaces"] ?? false,
    interfacesOutputDir: resolvePath(baseDir, interfacesDir),
    emitControllers: raw["emit-controllers"] ?? true,
    controllersOutputDir: resolvePath(baseDir, controllersDir),
    emitServices: raw["emit-services"] ?? true,
    servicesOutputDir: resolvePath(baseDir, servicesDir),
    emitHelpers: raw["emit-helpers"] ?? false,
    helpersOutputDir: resolvePath(baseDir, helpersDir),
    routePrefix: raw["route-prefix"] ?? "api/{version}",
    namespaceFromPath: useNamespaceFromPath,
    additionalUsings: raw["additional-usings"] ?? [],
    nullableProperties: raw["nullable-properties"] ?? true,
    abstractSuffix: raw["abstract-suffix"] ?? "Base",
    cancellationToken: raw["cancellation-token"] ?? true,
    templates: resolveTemplatePaths(raw.templates),
    emitValidators: raw["emit-validators"] ?? false,
    validatorsOutputDir: resolvePath(baseDir, validatorsDir),
    validatorsTypes: raw["validators"] ?? "both",
    validatorsVersionStrategy: raw["validators-version-strategy"],
    mergePatchStyle: raw["merge-patch-style"] ?? "generic",
  };
}

/**
 * Converts the raw `templates` option values (relative paths as the user types
 * them) to absolute paths that the renderer can use directly.
 *
 * @param templates - Raw template override map from user config.
 * @returns Template override map with all paths made absolute.
 */
function resolveTemplatePaths(
  templates: EmitterOptions["templates"],
): TemplateOverrides {
  if (!templates) return {};
  const out: TemplateOverrides = {};
  const keys: (keyof TemplateOverrides)[] = [
    "file",
    "class",
    "interface",
    "enum",
    "controller",
    "service-interface",
    "merge-patch",
    "entity-merge-patch",
    "enum-member-converter",
    "validator-post",
    "validator-patch",
    "validator-post-version-aware",
    "validator-patch-version-aware",
    "validator-initializer",
  ];
  for (const name of keys) {
    const value = templates[name as keyof typeof templates];
    if (value) out[name] = resolvePath(process.cwd(), value);
  }
  return out;
}

/**
 * Returns the fully-qualified TypeSpec namespace name, or an empty string for
 * the global namespace.
 *
 * @param ns - Namespace node, or `undefined`.
 * @returns Dot-separated namespace string.
 */
function namespaceFullName(ns: Namespace | undefined): string {
  if (!ns) return "";
  return getNamespaceFullName(ns) || "";
}

/**
 * Maps a TypeSpec namespace node to the C# namespace string used in generated
 * files.
 *
 * Applies the namespace-map (longest-match) and PascalCases each segment.
 * For top-level types (no TypeSpec namespace) the fallback order is:
 *   1. `sectionRootNs` — per-section root override when provided.
 *   2. `root-namespace` — the global root namespace when set.
 *   3. `DEFAULT_NAMESPACE` (`"Models"`) — the hard-coded default.
 *
 * @param ns - TypeSpec namespace node, or `undefined`.
 * @param options - Resolved options carrying the namespace map and root.
 * @param sectionRootNs - Optional per-section root (e.g. `models-root-namespace`)
 *   that takes priority over the global root for unnamespaced types.
 * @returns Dot-separated C# namespace string.
 */
export function csharpNamespaceFor(
  ns: Namespace | undefined,
  options: ResolvedOptions,
  sectionRootNs?: string,
): string {
  const fullNs = namespaceFullName(ns);
  if (!fullNs)
    return sectionRootNs ?? options.rootNamespace ?? DEFAULT_NAMESPACE;
  const mapped = applyNamespaceMap(fullNs, options.namespaceMap);
  return mapped.split(".").map(pascalCase).join(".");
}

/**
 * Applies the namespace-map to a fully-qualified TypeSpec namespace string.
 *
 * Entries are tested longest-key-first so that more-specific mappings win over
 * shorter prefix mappings.
 *
 * @param fullNs - Fully-qualified TypeSpec namespace string.
 * @param map - Pre-sorted namespace-map entries.
 * @returns The rewritten namespace, or the original if no entry matched.
 */
function applyNamespaceMap(
  fullNs: string,
  map: Array<{ key: string; value: string }>,
): string {
  for (const { key, value } of map) {
    if (fullNs === key) return value;
    if (fullNs.startsWith(key + ".")) return value + fullNs.slice(key.length);
  }
  return fullNs;
}

/**
 * Converts a C# namespace string to the relative folder path segments used
 * when placing files under the output directory.
 *
 * When `root-namespace` is set, strips that prefix from the namespace and
 * splits the remainder into segments.  Returns an empty array when:
 * - No `root-namespace` is configured.
 * - The namespace equals the root (file goes in the output root).
 * - The namespace does not start with the root prefix.
 *
 * @param rootNs - The configured `root-namespace`, or `undefined`.
 * @param csharpNs - The C# namespace for the type being emitted.
 * @returns Array of folder name segments (may be empty).
 */
export function folderSegments(
  rootNs: string | undefined,
  csharpNs: string,
): string[] {
  if (!rootNs) return [];
  if (csharpNs === rootNs) return [];
  if (csharpNs.startsWith(rootNs + ".")) {
    return csharpNs.slice(rootNs.length + 1).split(".");
  }
  return [];
}
