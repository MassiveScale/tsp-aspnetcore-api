/**
 * @module emitter
 *
 * Core TypeSpec emitter.  The exported {@link $onEmit} function is called by
 * the TypeSpec compiler for every `emit` run and is responsible for:
 *
 * 1. Resolving all user-supplied options.
 * 2. Collecting models, enums, and HTTP service operations from the compiled
 *    program.
 * 3. Rendering each artifact through Handlebars templates.
 * 4. Writing the resulting `.g.cs` (or custom-extension) files to disk via the
 *    TypeSpec `emitFile` API.
 */

import {
  EmitContext,
  Enum,
  Model,
  ModelProperty,
  Namespace,
  Program,
  Type,
  emitFile,
  getDoc,
  getFormat,
  getNamespaceFullName,
  isArrayModelType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  navigateProgram,
  NoTarget,
  resolvePath,
} from "@typespec/compiler";
import { EmitterOptions, reportDiagnostic } from "./lib.js";
import {
  ClassView,
  EnumView,
  InterfaceView,
  PropertyView,
  Renderer,
  TemplateName,
  TemplateOverrides,
  createRenderer,
  renderDocComment,
} from "./renderer.js";
import { ControllerGroup, ControllerOptions, collectControllers } from "./controllers.js";

/** Default C# namespace used for top-level TypeSpec models with no namespace. */
const DEFAULT_NAMESPACE = "Models";

/** `using` directives included in every model / interface / enum file. */
const SYSTEM_USINGS = ["System", "System.Collections.Generic", "System.Text.Json.Serialization"];

/** `using` directives included in every controller and service file. */
const CONTROLLER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Threading.Tasks",
  "Microsoft.AspNetCore.Mvc",
];

/** `using` directives included in the MergePatchValue helper file. */
const HELPER_USINGS = ["System", "System.Text.Json", "System.Text.Json.Serialization"];

/** `using` directives included in the EnumMemberConverter helper file. */
const ENUM_CONVERTER_HELPER_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Reflection",
  "System.Runtime.Serialization",
  "System.Text.Json",
  "System.Text.Json.Serialization",
];

/** `using` directives included in every enum file. */
const ENUM_USINGS = ["System", "System.Collections.Generic", "System.Runtime.Serialization", "System.Text.Json.Serialization"];

/** Maps TypeSpec built-in scalar names to C# primitive type strings. */
const SCALAR_MAP: Record<string, string> = {
  string: "string",
  boolean: "bool",
  bytes: "byte[]",
  int8: "sbyte",
  int16: "short",
  int32: "int",
  int64: "long",
  uint8: "byte",
  uint16: "ushort",
  uint32: "uint",
  uint64: "ulong",
  safeint: "long",
  integer: "long",
  float: "double",
  float32: "float",
  float64: "double",
  decimal: "decimal",
  decimal128: "decimal",
  numeric: "double",
  plainDate: "DateOnly",
  plainTime: "TimeOnly",
  utcDateTime: "DateTimeOffset",
  offsetDateTime: "DateTimeOffset",
  duration: "TimeSpan",
  url: "Uri",
};

/** Maps TypeSpec `@format` annotation values to C# type strings. */
const FORMAT_MAP: Record<string, string> = {
  uuid: "Guid",
  guid: "Guid",
  uri: "Uri",
  url: "Uri",
  "date-time": "DateTimeOffset",
  date: "DateOnly",
  time: "TimeOnly",
};

/**
 * Fully-resolved emitter configuration, derived from raw {@link EmitterOptions}
 * and the `EmitContext`.  All paths are absolute; all optional fields have
 * defaults applied.
 */
interface ResolvedOptions {
  /** Value of `root-namespace`, or `undefined` if not configured. */
  rootNamespace: string | undefined;
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
  /** Resolved template override paths (absolute). */
  templates: TemplateOverrides;
  /** Whether to emit helper files (`MergePatchValue`, `EnumMemberConverter`). */
  emitHelpers: boolean;
  /** Absolute path to the helpers output directory. */
  helpersOutputDir: string;
  /** Whether to derive C# namespaces from output folder paths (controllers, services, helpers). */
  namespaceFromPath: boolean;
  /**
   * PascalCased namespace suffix derived from `models-output-dir` path segments
   * (e.g. `"models"` → `"Models"`, `"src/models"` → `"Src.Models"`).
   * Empty string when no `models-output-dir` is configured.
   */
  modelsDirSuffix: string;
  /**
   * PascalCased namespace suffix derived from `interfaces-output-dir` path segments.
   * Empty string when no `interfaces-output-dir` is configured.
   */
  interfacesDirSuffix: string;
  /** Path-derived namespace for controller files (used when `namespaceFromPath` is `true`). */
  controllersPathNamespace: string;
  /** Path-derived namespace for service files (used when `namespaceFromPath` is `true`). */
  servicesPathNamespace: string;
  /** C# namespace for helper files (always path-derived). */
  helpersNamespace: string;
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
 *
 * @param context - Emit context provided by the TypeSpec compiler, carrying the
 *   compiled program, resolved options, and output directory path.
 */
export async function $onEmit(context: EmitContext<EmitterOptions>): Promise<void> {
  if (context.program.compilerOptions.noEmit) {
    return;
  }

  const program = context.program;
  const options = resolveOptions(context);

  const renderer = buildRenderer(program, options);
  if (!renderer) return;

  // ── Models & enums ──────────────────────────────────────────────────────────
  const models: Model[] = [];
  const enums: Enum[] = [];

  navigateProgram(program, {
    model(model) {
      if (shouldEmitModel(model)) models.push(model);
    },
    enum(en) {
      if (shouldEmitEnum(en)) enums.push(en);
    },
  });

  const hasMergePatchUpdateModels = models.some(isMergePatchUpdateModel);

  for (const model of models) {
    const isMergePatchModel = isMergePatchUpdateModel(model);
    const typespecNs = csharpNamespaceFor(model.namespace, options);
    // When `namespaceFromPath` is enabled and an output-dir is configured,
    // append the PascalCased dir segments to the TypeSpec namespace so the C#
    // namespace reflects the physical output path
    // (e.g. "App.Users" + models-dir "models" → "App.Users.Models").
    // When no dir is configured, or `namespaceFromPath` is disabled, use the
    // TypeSpec namespace as-is and let `folderSegments` compute the sub-path.
    const classNs =
      options.namespaceFromPath && options.modelsDirSuffix
        ? `${typespecNs}.${options.modelsDirSuffix}`
        : typespecNs;
    const interfaceNs =
      options.namespaceFromPath && options.interfacesDirSuffix
        ? `${typespecNs}.${options.interfacesDirSuffix}`
        : typespecNs;
    // Flatten into the output dir when a suffix was applied; otherwise keep
    // the folderSegments sub-directory layout.
    const classFolder =
      options.namespaceFromPath && options.modelsDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecNs);
    const interfaceFolder =
      options.namespaceFromPath && options.interfacesDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecNs);
    const refs = modelReferences(model);
    // Pass modelsDirSuffix so that usings for referenced types also resolve to
    // the correct suffixed namespace.
    const classUsings = collectUsings(
      classNs,
      refs,
      options,
      options.modelsDirSuffix,
      isMergePatchModel,
    );
    const interfaceUsings = collectUsings(
      interfaceNs,
      refs,
      options,
      options.modelsDirSuffix,
      isMergePatchModel,
    );

    const classFileName = `${pascalCase(model.name)}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...classFolder, classFileName),
      content: renderer.renderFile({
        fileName: classFileName,
        namespace: classNs,
        usings: classUsings,
        body: renderer.renderClass(buildClassView(program, model, options, isMergePatchModel)),
      }),
    });

    if (options.emitInterfaces) {
      const interfaceFileName = `I${pascalCase(model.name)}${options.fileExtension}`;
      await emitFile(program, {
        path: resolvePath(options.interfacesOutputDir, ...interfaceFolder, interfaceFileName),
        content: renderer.renderFile({
          fileName: interfaceFileName,
          namespace: interfaceNs,
          usings: interfaceUsings,
          body: renderer.renderInterface(
            buildInterfaceView(program, model, options, isMergePatchModel),
          ),
        }),
      });
    }
  }

  for (const en of enums) {
    // Enums follow the same namespace strategy as model classes.
    const typespecEnumNs = csharpNamespaceFor(en.namespace, options);
    const ns =
      options.namespaceFromPath && options.modelsDirSuffix
        ? `${typespecEnumNs}.${options.modelsDirSuffix}`
        : typespecEnumNs;
    const folder =
      options.namespaceFromPath && options.modelsDirSuffix
        ? []
        : folderSegments(options.rootNamespace, typespecEnumNs);
    const enumFileName = `${pascalCase(en.name)}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.modelsOutputDir, ...folder, enumFileName),
      content: renderer.renderFile({
        fileName: enumFileName,
        namespace: ns,
        usings: collectEnumUsings(ns, options),
        body: renderer.renderEnum(buildEnumView(program, en)),
      }),
    });
  }

  // ── Controllers & services ──────────────────────────────────────────────────
  const controllerOptions: ControllerOptions = {
    routePrefix: options.routePrefix,
    nullableProperties: options.nullableProperties,
    abstractSuffix: options.abstractSuffix,
  };

  const groups = collectControllers(
    program,
    controllerOptions,
    (ns) => csharpNamespaceFor(ns, options),
    (ns) => folderSegments(options.rootNamespace, ns),
  );

  for (const group of groups) {
    await emitControllerGroup(program, group, renderer, options);
  }

  if (options.emitHelpers || hasMergePatchUpdateModels) {
    await emitHelpers(program, renderer, options);
  }
}

/**
 * Writes the controller file and the service-interface file for one
 * {@link ControllerGroup}.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param group - The controller group to emit.
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options (for output paths and extension).
 */
async function emitControllerGroup(
  program: Program,
  group: ControllerGroup,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const { controllerView, serviceView } = group;

  // When namespace-from-path is enabled, derive namespaces from the output
  // folder path and flatten files into the configured output dirs (no sub-folders).
  const ctrlNamespace = options.namespaceFromPath
    ? options.controllersPathNamespace
    : group.namespace;
  const svcNamespace = options.namespaceFromPath
    ? options.servicesPathNamespace
    : group.namespace;
  const folder = options.namespaceFromPath ? [] : group.folder;

  if (options.emitControllers) {
    const controllerFileName = `${controllerView.controllerName}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.controllersOutputDir, ...folder, controllerFileName),
      content: renderer.renderFile({
        fileName: controllerFileName,
        namespace: ctrlNamespace,
        usings: sortUsings(new Set(CONTROLLER_USINGS)),
        body: renderer.renderController(controllerView),
      }),
    });
  }

  if (options.emitServices) {
    const serviceInterfaceFileName = `${serviceView.interfaceName}${options.fileExtension}`;
    await emitFile(program, {
      path: resolvePath(options.servicesOutputDir, ...folder, serviceInterfaceFileName),
      content: renderer.renderFile({
        fileName: serviceInterfaceFileName,
        namespace: svcNamespace,
        usings: sortUsings(new Set(["System", "System.Collections.Generic", "System.Threading.Tasks"])),
        body: renderer.renderServiceInterface(serviceView),
      }),
    });
  }
}

/**
 * Writes the static `MergePatchValue<T>` helper class to the helpers output
 * directory.
 *
 * @param program - The compiled TypeSpec program (needed by `emitFile`).
 * @param renderer - Pre-compiled renderer instance.
 * @param options - Resolved emitter options.
 */
async function emitHelpers(
  program: Program,
  renderer: Renderer,
  options: ResolvedOptions,
): Promise<void> {
  const mergePatchFileName = `MergePatchValue${options.fileExtension}`;
  await emitFile(program, {
    path: resolvePath(options.helpersOutputDir, mergePatchFileName),
    content: renderer.renderFile({
      fileName: mergePatchFileName,
      namespace: options.helpersNamespace,
      usings: sortUsings(new Set(HELPER_USINGS)),
      body: renderer.renderMergePatchValue(),
    }),
  });

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

/**
 * Sorts a set of `using` namespace strings with `System` namespaces first,
 * then alphabetically within each group.
 *
 * @param set - Unsorted set of namespace strings.
 * @returns Sorted array of namespace strings.
 */
function sortUsings(set: Set<string>): string[] {
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
    const name = (Object.entries(options.templates).find(([, p]) => p === path)?.[0] ??
      "unknown") as TemplateName;
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
 * Derives a C# namespace from a root namespace and a relative output directory
 * path.  Each path segment is PascalCased and joined with dots.
 *
 * @param rootNs - Configured `root-namespace`, or `undefined`.
 * @param rawDir - Relative output directory, e.g. `"Controllers"` or `"src/api"`.
 * @returns Dot-separated C# namespace string.
 *
 * @example
 * pathNamespace("MyApp", "Controllers") // → "MyApp.Controllers"
 * pathNamespace(undefined, "Services")  // → "Services"
 */
function pathNamespace(rootNs: string | undefined, rawDir: string): string {
  const segments = rawDir
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(pascalCase);
  return rootNs ? [rootNs, ...segments].join(".") : segments.join(".");
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
    const children = [...ns.namespaces.values()].filter((n) => !isStdNamespace(n));
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
  const modelsDir = raw["models-output-dir"] ?? "";
  const interfacesDir = raw["interfaces-output-dir"] ?? "";
  const controllersDir = raw["controllers-output-dir"] ?? "Controllers";
  const servicesDir = raw["services-output-dir"] ?? "Services";
  const helpersDir = raw["helpers-output-dir"] ?? "Helpers";
  const rootNs = raw["root-namespace"];
  // When the user does not supply root-namespace, infer it from the TypeSpec
  // namespace tree so that controller, service, and helper files automatically
  // receive a properly-qualified namespace (e.g. "MyApp.Controllers" rather
  // than just "Controllers").
  const effectiveRootNs = rootNs ?? inferRootNamespace(context.program);
  return {
    rootNamespace: rootNs,
    namespaceMap,
    fileExtension: raw["file-extension"] ?? ".g.cs",
    modelsOutputDir: modelsDir ? resolvePath(baseDir, modelsDir) : baseDir,
    emitInterfaces: raw["emit-interfaces"] ?? true,
    interfacesOutputDir: interfacesDir ? resolvePath(baseDir, interfacesDir) : baseDir,
    emitControllers: raw["emit-controllers"] ?? true,
    controllersOutputDir: resolvePath(baseDir, controllersDir),
    emitServices: raw["emit-services"] ?? true,
    servicesOutputDir: resolvePath(baseDir, servicesDir),
    emitHelpers: raw["emit-helpers"] ?? false,
    helpersOutputDir: resolvePath(baseDir, helpersDir),
    routePrefix: raw["route-prefix"] ?? "api",
    namespaceFromPath: raw["namespace-from-path"] ?? true,
    modelsDirSuffix: pathNamespace(undefined, modelsDir),
    interfacesDirSuffix: pathNamespace(undefined, interfacesDir),
    controllersPathNamespace: pathNamespace(effectiveRootNs, controllersDir),
    servicesPathNamespace: pathNamespace(effectiveRootNs, servicesDir),
    helpersNamespace: pathNamespace(effectiveRootNs, helpersDir),
    additionalUsings: raw["additional-usings"] ?? [],
    nullableProperties: raw["nullable-properties"] ?? true,
    abstractSuffix: raw["abstract-suffix"] ?? "Base",
    templates: resolveTemplatePaths(raw.templates),
  };
}

/**
 * Converts the raw `templates` option values (relative paths as the user types
 * them) to absolute paths that the renderer can use directly.
 *
 * @param templates - Raw template override map from user config.
 * @returns Template override map with all paths made absolute.
 */
function resolveTemplatePaths(templates: EmitterOptions["templates"]): TemplateOverrides {
  if (!templates) return {};
  const out: TemplateOverrides = {};
  const keys: (keyof TemplateOverrides)[] = [
    "file",
    "class",
    "interface",
    "enum",
    "controller",
    "service-interface",
    "merge-patch-value",
    "enum-member-converter",
  ];
  for (const name of keys) {
    const value = templates[name as keyof typeof templates];
    if (value) out[name] = resolvePath(process.cwd(), value);
  }
  return out;
}

/**
 * Returns `true` for models that should produce a class and interface file.
 *
 * Filters out unnamed models, standard-library types, arrays, records, and
 * template declarations.
 *
 * @param model - TypeSpec model node.
 * @returns Whether the model should be emitted.
 */
function shouldEmitModel(model: Model): boolean {
  if (!model.name) return false;
  if (isInStdNamespace(model.namespace)) return false;
  if (isArrayModelType(model)) return false;
  if (isRecordModelType(model)) return false;
  if (isTemplateDeclaration(model)) return false;
  return true;
}

/**
 * Returns `true` for enums that should produce a file.
 *
 * Filters out unnamed enums and standard-library types.
 *
 * @param en - TypeSpec enum node.
 * @returns Whether the enum should be emitted.
 */
function shouldEmitEnum(en: Enum): boolean {
  if (!en.name) return false;
  if (isInStdNamespace(en.namespace)) return false;
  return true;
}

/**
 * Returns `true` if the given namespace (or any of its ancestors) is a
 * TypeSpec standard-library namespace.
 *
 * @param ns - Namespace node to test, or `undefined` for the global namespace.
 * @returns Whether the namespace is part of the TypeSpec standard library.
 */
function isInStdNamespace(ns: Namespace | undefined): boolean {
  let current: Namespace | undefined = ns;
  while (current) {
    if (isStdNamespace(current)) return true;
    current = current.namespace;
  }
  return false;
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
 * Falls back to `root-namespace` (if set) or `"Models"` for top-level types.
 *
 * @param ns - TypeSpec namespace node, or `undefined`.
 * @param options - Resolved options carrying the namespace map and root.
 * @returns Dot-separated C# namespace string.
 */
function csharpNamespaceFor(ns: Namespace | undefined, options: ResolvedOptions): string {
  const fullNs = namespaceFullName(ns);
  if (!fullNs) return options.rootNamespace ?? DEFAULT_NAMESPACE;
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
function folderSegments(rootNs: string | undefined, csharpNs: string): string[] {
  if (!rootNs) return [];
  if (csharpNs === rootNs) return [];
  if (csharpNs.startsWith(rootNs + ".")) {
    return csharpNs.slice(rootNs.length + 1).split(".");
  }
  return [];
}

/**
 * Collects all TypeSpec types directly referenced by a model (base class and
 * all property types).
 *
 * @param model - The TypeSpec model node.
 * @returns Array of referenced TypeSpec type nodes.
 */
function modelReferences(model: Model): Type[] {
  const refs: Type[] = [];
  if (model.baseModel) refs.push(model.baseModel);
  for (const prop of model.properties.values()) {
    refs.push(prop.type);
  }
  return refs;
}

/**
 * Recursively yields all {@link Model} and {@link Enum} nodes reachable from a
 * single TypeSpec type reference.
 *
 * Used to collect the set of C# namespaces that need `using` directives.
 *
 * @param type - Starting TypeSpec type node.
 * @yields All transitively referenced model and enum types.
 */
function* collectReferencedTypes(type: Type): Generator<Model | Enum> {
  switch (type.kind) {
    case "Model":
      if (isArrayModelType(type) || isRecordModelType(type)) {
        yield* collectReferencedTypes(type.indexer.value);
      } else if (type.name) {
        yield type;
      }
      break;
    case "Enum":
      yield type;
      break;
    case "Union":
      for (const variant of type.variants.values()) {
        yield* collectReferencedTypes(variant.type);
      }
      break;
  }
}

/**
 * Builds the sorted list of `using` namespaces for a single emitted file.
 *
 * Starts from {@link SYSTEM_USINGS}, adds any `additional-usings`, then adds
 * the C# namespace for each transitively-referenced type that lives in a
 * different namespace.  Deduplicates and sorts (System first).
 *
 * @param ownNamespace - The C# namespace of the file being emitted.
 * @param references - TypeSpec type nodes referenced by the model.
 * @param options - Resolved options (namespace map, additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function collectUsings(
  ownNamespace: string,
  references: Type[],
  options: ResolvedOptions,
  /** The dir-suffix currently applied to the emitting file's namespace. */
  dirSuffix = "",
  usesMergePatchValue = false,
): string[] {
  const usings = new Set<string>(SYSTEM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  for (const ref of references) {
    for (const type of collectReferencedTypes(ref)) {
      const typespecNs = csharpNamespaceFor(type.namespace, options);
      // When a dir-suffix has been applied to the emitting file's namespace,
      // the same suffix must be applied to referenced types so that
      // using-directives point at the correct C# namespace.
      const ns =
        options.namespaceFromPath && dirSuffix && typespecNs
          ? `${typespecNs}.${dirSuffix}`
          : typespecNs;
      if (ns && ns !== ownNamespace) usings.add(ns);
    }
  }
  if (usesMergePatchValue && options.helpersNamespace !== ownNamespace) {
    usings.add(options.helpersNamespace);
  }
  return sortUsings(usings);
}

/**
 * Builds the sorted list of `using` namespaces for a generated enum file.
 *
 * Includes {@link ENUM_USINGS}, any `additional-usings`, and the helpers
 * namespace so that `EnumMemberConverterFactory` can be referenced.
 *
 * @param ownNamespace - The C# namespace of the enum file being emitted.
 * @param options - Resolved options (helpers namespace, additional usings).
 * @returns Sorted, deduplicated array of `using` namespace strings.
 */
function collectEnumUsings(ownNamespace: string, options: ResolvedOptions): string[] {
  const usings = new Set<string>(ENUM_USINGS);
  for (const u of options.additionalUsings) usings.add(u);
  if (options.helpersNamespace && options.helpersNamespace !== ownNamespace) {
    usings.add(options.helpersNamespace);
  }
  return sortUsings(usings);
}

/**
 * Builds a {@link ClassView} from a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Populated class view model.
 */
function buildClassView(
  program: Program,
  model: Model,
  options: ResolvedOptions,
  isMergePatchModel: boolean,
): ClassView {
  const className = pascalCase(model.name);
  return {
    doc: docFor(program, model),
    className,
    interfaceName: `I${className}`,
    baseClass: model.baseModel ? typeReference(model.baseModel) : undefined,
    properties: buildPropertyViews(program, model, options, isMergePatchModel),
  };
}

/**
 * Builds an {@link InterfaceView} from a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Populated interface view model.
 */
function buildInterfaceView(
  program: Program,
  model: Model,
  options: ResolvedOptions,
  isMergePatchModel: boolean,
): InterfaceView {
  return {
    doc: docFor(program, model),
    interfaceName: `I${pascalCase(model.name)}`,
    baseInterface: model.baseModel ? `I${pascalCase(model.baseModel.name)}` : undefined,
    properties: buildPropertyViews(program, model, options, isMergePatchModel),
  };
}

/**
 * Builds an {@link EnumView} from a TypeSpec enum.
 *
 * @param program - The compiled TypeSpec program.
 * @param en - The TypeSpec enum node.
 * @returns Populated enum view model.
 */
function buildEnumView(program: Program, en: Enum): EnumView {
  const enumDoc = getDoc(program, en);
  return {
    doc: enumDoc ? renderDocComment(enumDoc) : undefined,
    enumName: pascalCase(en.name),
    members: [...en.members.values()].map((member) => {
      const memberDoc = getDoc(program, member);
      return {
        doc: memberDoc ? renderDocComment(memberDoc) : undefined,
        name: pascalCase(member.name),
        value: typeof member.value === "number" ? member.value : undefined,
        memberValue: typeof member.value === "string" ? member.value : member.name,
      };
    }),
  };
}

/**
 * Builds the ordered array of {@link PropertyView} objects for all properties
 * of a TypeSpec model.
 *
 * @param program - The compiled TypeSpec program.
 * @param model - The TypeSpec model node.
 * @param options - Resolved options for type resolution and nullability.
 * @returns Array of property view models in declaration order.
 */
function buildPropertyViews(
  program: Program,
  model: Model,
  options: ResolvedOptions,
  isMergePatchModel: boolean,
): PropertyView[] {
  return [...model.properties.values()].map((prop) => {
    const type = propertyTypeName(program, prop, options, isMergePatchModel);
    return {
      doc: docFor(program, prop),
      type,
      name: pascalCase(prop.name),
      jsonName: camelCase(prop.name),
      nullable: type.endsWith("?"),
      initializer:
        isMergePatchModel && type.startsWith("MergePatchValue<")
          ? `${type}.Absent`
          : undefined,
    };
  });
}

/**
 * Retrieves and pre-renders the `@doc` annotation for a model or property.
 *
 * @param program - The compiled TypeSpec program.
 * @param target - The annotated model or model property.
 * @returns Pre-rendered XML summary string, or `undefined` if no doc is present.
 */
function docFor(program: Program, target: Model | ModelProperty): string | undefined {
  const doc = getDoc(program, target);
  return doc ? renderDocComment(doc) : undefined;
}

/**
 * Resolves the C# type string for a model property, including nullability.
 *
 * Checks `@format` annotations (on the property and its scalar type) before
 * falling through to {@link typeReference}.  Appends `?` when the property is
 * optional or when `nullable-properties` is enabled.
 *
 * @param program - The compiled TypeSpec program.
 * @param prop - The model property to resolve.
 * @param options - Resolved options for nullability and format mapping.
 * @returns C# type string, possibly suffixed with `?`.
 */
function propertyTypeName(
  program: Program,
  prop: ModelProperty,
  options: ResolvedOptions,
  isMergePatchModel: boolean,
): string {
  const propFormat = getFormat(program, prop);
  const scalarFormat =
    prop.type.kind === "Scalar" ? getFormat(program, prop.type) : undefined;
  const format = propFormat ?? scalarFormat;
  let type: string;
  if (format && FORMAT_MAP[format.toLowerCase()]) {
    type = FORMAT_MAP[format.toLowerCase()];
  } else {
    type = typeReference(prop.type);
  }
  const nullable = prop.optional || options.nullableProperties;
  const nullableType = nullable && !type.endsWith("?") ? `${type}?` : type;
  if (isMergePatchModel) {
    return `MergePatchValue<${nullableType}>`;
  }
  return nullableType;
}

/**
 * Returns true when a generated model represents TypeSpec MergePatchUpdate.
 */
function isMergePatchUpdateModel(model: Model): boolean {
  return /MergePatchUpdate$/i.test(model.name);
}

/**
 * Recursively resolves the C# type string for any TypeSpec {@link Type} node,
 * without applying nullability.
 *
 * @param type - The TypeSpec type node to resolve.
 * @returns C# type string (non-nullable).
 */
function typeReference(type: Type): string {
  switch (type.kind) {
    case "Scalar": {
      const mapped = SCALAR_MAP[type.name];
      if (mapped) return mapped;
      let parent = type.baseScalar;
      while (parent) {
        const m = SCALAR_MAP[parent.name];
        if (m) return m;
        parent = parent.baseScalar;
      }
      return "object";
    }
    case "Model": {
      if (isArrayModelType(type)) {
        return `IList<${typeReference(type.indexer.value)}>`;
      }
      if (isRecordModelType(type)) {
        return `IDictionary<string, ${typeReference(type.indexer.value)}>`;
      }
      return pascalCase(type.name || "object");
    }
    case "Enum":
      return pascalCase(type.name);
    case "Boolean":
      return "bool";
    case "String":
      return "string";
    case "Number":
      return "double";
    case "Union": {
      const variants = [...type.variants.values()];
      const nonNull = variants.filter(
        (v) => !(v.type.kind === "Intrinsic" && v.type.name === "null"),
      );
      const hasNull = nonNull.length !== variants.length;
      if (nonNull.length === 1) {
        const ref = typeReference(nonNull[0].type);
        return hasNull ? `${ref}?` : ref;
      }
      return "object";
    }
    case "Intrinsic":
      if (type.name === "null") return "object?";
      return "object";
    case "Tuple":
      return "object";
    default:
      return "object";
  }
}

/**
 * Converts a string to camelCase by PascalCasing it then lowercasing the
 * first character.
 *
 * @param name - Input string.
 * @returns camelCase string.
 */
function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}

/**
 * Converts a string to PascalCase by splitting on `_`, `-`, and whitespace.
 *
 * @param name - Input string.
 * @returns PascalCase string.
 */
function pascalCase(name: string): string {
  if (!name) return name;
  return name
    .split(/[_\-\s]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("");
}
