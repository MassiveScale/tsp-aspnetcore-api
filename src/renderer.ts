/**
 * @module renderer
 *
 * Handlebars-based template renderer for C# code generation.
 *
 * Provides view-model types that carry structured data from the emitter to the
 * templates, helper functions for rendering individual text fragments (property
 * declarations, operation signatures, etc.), and a factory (`createRenderer`)
 * that compiles all templates once and returns a stateless {@link Renderer}.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

/** Absolute path to the bundled default templates directory. */
const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../templates");

/**
 * Names of the built-in Handlebars templates.
 * Each name maps to a `<name>.hbs` file inside {@link TEMPLATES_DIR}.
 */
export type TemplateName =
  | "file"
  | "class"
  | "interface"
  | "enum"
  | "controller"
  | "service-interface"
  | "merge-patch-value"
  | "enum-member-converter";

/**
 * Partial map of template names to absolute file paths used to override the
 * built-in defaults.  Any template not listed here falls back to its bundled
 * counterpart.
 */
export type TemplateOverrides = Partial<Record<TemplateName, string>>;

// ---------------------------------------------------------------------------
// Model view models
// ---------------------------------------------------------------------------

/** View model for a single C# property declaration. */
export interface PropertyView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** Fully-qualified C# type string, e.g. `"string?"` or `"IList<Guid>?"`. */
  type: string;
  /** PascalCase property name. */
  name: string;
  /** camelCase JSON property name for `[JsonPropertyName]`, e.g. `"firstName"`. */
  jsonName: string;
  /** `true` when the type is nullable (ends with `?`); drives `[JsonIgnore]`. */
  nullable: boolean;
  /** Optional C# expression used to initialize the property. */
  initializer?: string;
}

/** View model for a C# class (`public partial class`). */
export interface ClassView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** PascalCase class name. */
  className: string;
  /** Name of the generated companion interface, e.g. `"IUser"`. */
  interfaceName: string;
  /** Name of the C# base class if the TypeSpec model extends another model. */
  baseClass?: string;
  /** Ordered list of property view models for this class. */
  properties: PropertyView[];
}

/** View model for a C# interface (`public partial interface`). */
export interface InterfaceView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** Interface name, e.g. `"IUser"`. */
  interfaceName: string;
  /** Name of the base interface when the model uses `extends`, e.g. `"IAnimal"`. */
  baseInterface?: string;
  /** Ordered list of property view models for this interface. */
  properties: PropertyView[];
}

/** View model for a single C# enum member. */
export interface EnumMemberView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** PascalCase member name. */
  name: string;
  /**
   * Wire string written to / read from JSON.  Taken from the TypeSpec string
   * value when present, otherwise the original (un-PascalCased) TypeSpec name.
   * Written as `[EnumMember(Value = "...")]` on the generated member.
   */
  memberValue: string;
  /**
   * Explicit numeric value, present only when the TypeSpec member carries an
   * integer literal value.  Omitted for string-valued or auto-numbered members.
   */
  value?: number;
}

/** View model for a C# enum declaration. */
export interface EnumView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** PascalCase enum name. */
  enumName: string;
  /** Ordered list of enum members. */
  members: EnumMemberView[];
}

/**
 * View model passed to the `file` template.
 * Wraps any inner declaration (class, interface, enum) with the namespace
 * block and `using` directives.
 */
export interface FileView {
  /** Fully-qualified C# namespace string. */
  namespace: string;
  /** Sorted list of `using` directive namespaces (without the `using` keyword). */
  usings: string[];
  /** Pre-rendered inner declaration body to be placed inside the namespace block. */
  body: string;
  /**
   * The filename (basename only, no directory) of the file being emitted,
   * e.g. `"Person.g.cs"` or `"IUser.g.cs"`.
   * Available in templates as `{{fileName}}`.
   */
  fileName: string;
}

// ---------------------------------------------------------------------------
// Controller / service view models
// ---------------------------------------------------------------------------

/** View model for a single action-method parameter. */
export interface OperationParamView {
  /** camelCase parameter name. */
  name: string;
  /** C# type string (non-nullable; optional marker is added by the renderer). */
  type: string;
  /** ASP.NET Core binding source attribute name (without brackets). */
  binding: "FromRoute" | "FromQuery" | "FromBody" | "FromHeader";
  /** Whether the parameter is optional in the TypeSpec definition. */
  optional: boolean;
}

/** View model for a single controller action / service method. */
export interface OperationView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** PascalCase operation name, used as both method name and service method stem. */
  name: string;
  /** PascalCase HTTP verb, e.g. `"Get"`, `"Post"`. */
  httpVerb: string;
  /**
   * Full absolute route strings for this operation, one per API version.
   * e.g. `["/api/v1/users/{id}", "/api/v2/users/{id}"]`.
   * Each string becomes its own `[HttpVerb("...")]` attribute on the method.
   */
  routes: string[];
  /**
   * Route template suffix from the TypeSpec `@route` decorator on the
   * operation itself, e.g. `"{id}"`.  Informational only — not used for
   * controller routing.  `undefined` when the operation sits at the
   * container root.
   */
  routeSuffix?: string;
  /** Ordered list of parameter view models. */
  params: OperationParamView[];
  /** C# return type for the service method, e.g. `"User"` or `"IList<Widget>"`.  The
   * special value `"void"` indicates that the operation has no response body and the
   * service method should return a plain `Task` with no type parameter. */
  returnType: string;
}

/** View model for an ASP.NET Core abstract controller class. */
export interface ControllerView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** Full class name including the abstract suffix, e.g. `"UsersControllerBase"`. */
  controllerName: string;
  /** Abstract service class name, e.g. `"UsersServiceBase"`. */
  serviceName: string;
  /** Service interface name, e.g. `"IUsersService"`. */
  serviceInterfaceName: string;
  /** Ordered list of action-method view models. */
  operations: OperationView[];
}

/** View model for a service interface (`public interface I<Name>Service`). */
export interface ServiceView {
  /** Optional XML `<summary>` doc comment (pre-rendered). */
  doc?: string;
  /** Abstract service class name, e.g. `"UsersServiceBase"`. */
  serviceName: string;
  /** Service interface name, e.g. `"IUsersService"`. */
  interfaceName: string;
  /** Ordered list of service-method view models. */
  operations: OperationView[];
}

// ---------------------------------------------------------------------------
// Renderer interface
// ---------------------------------------------------------------------------

/**
 * Stateless code renderer.  Each method accepts a view model and returns the
 * rendered C# source fragment as a string.
 *
 * Obtain an instance via {@link createRenderer}.
 */
export interface Renderer {
  /** Renders the full file content: `// <auto-generated/>`, usings, namespace block. */
  renderFile(view: FileView): string;
  /** Renders a `public partial class` declaration with its properties. */
  renderClass(view: ClassView): string;
  /** Renders a `public partial interface` declaration with its properties. */
  renderInterface(view: InterfaceView): string;
  /** Renders a `public enum` declaration with its members. */
  renderEnum(view: EnumView): string;
  /** Renders an `[ApiController] public abstract class` controller declaration. */
  renderController(view: ControllerView): string;
  /** Renders a `public interface I<Name>Service` declaration. */
  renderServiceInterface(view: ServiceView): string;
  /** Renders the static `MergePatchValue<T>` helper class body. */
  renderMergePatchValue(): string;
  /** Renders the `EnumMemberConverterFactory` and `EnumMemberConverter<T>` helper class body. */
  renderEnumMemberConverter(): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a plain-text doc string in an XML `<summary>` block suitable for
 * inclusion in generated C# source.
 *
 * @param doc - Raw documentation text (may contain newlines).
 * @returns Multi-line string of `/// ` prefixed lines.
 *
 * @example
 * renderDocComment("Gets the user by id.")
 * // → "/// <summary>\n/// Gets the user by id.\n/// </summary>"
 */
export function renderDocComment(doc: string): string {
  const lines = doc.split(/\r?\n/);
  return ["/// <summary>", ...lines.map((l) => `/// ${l}`), "/// </summary>"].join("\n");
}

/**
 * Creates a fresh Handlebars environment with custom helpers registered.
 * A new environment is used per renderer instance so helpers from different
 * invocations cannot bleed into each other.
 *
 * Registered helpers:
 * - `indent` — prefixes every non-empty line with 4 spaces.
 * - `isDefined` — subexpression helper; true when its argument is not `undefined`.
 *
 * @returns Isolated Handlebars environment.
 */
function createHandlebarsEnv(): typeof Handlebars {
  const env = Handlebars.create();

  /**
   * `{{indent text}}` — prefix every non-empty line of `text` with 4 spaces.
   * Used inside body templates to place content inside a namespace or class block.
   */
  env.registerHelper("indent", (content: unknown) => {
    if (typeof content !== "string" || !content) return "";
    return content
      .split("\n")
      .map((line) => (line.length ? `    ${line}` : ""))
      .join("\n");
  });

  /**
   * `{{isDefined value}}` — returns true when `value` is not `undefined`.
   * Useful in enum templates to distinguish an explicit `= 0` from no value.
   *
   * @example `{{#if (isDefined value)}} = {{value}}{{/if}}`
   */
  env.registerHelper("isDefined", (value: unknown) => value !== undefined);

  /**
   * `{{eq a b}}` — returns true when `a` strictly equals `b`.
   * Useful in service templates to test `{{#if (eq returnType "void")}}Task{{else}}Task<{{returnType}}?>{{/if}}`.
   */
  env.registerHelper("eq", (a: unknown, b: unknown) => a === b);

  return env;
}

/**
 * Compiles a Handlebars template source string with HTML escaping disabled.
 *
 * @param env - Handlebars environment to use for compilation.
 * @param source - Raw template source.
 * @returns Compiled template delegate.
 */
function compileTemplate(env: typeof Handlebars, source: string): HandlebarsTemplateDelegate {
  return env.compile(source, { noEscape: true });
}

/**
 * Loads and compiles a named template, falling back to the bundled default
 * when no override path is provided.
 *
 * @param env - Handlebars environment for compilation.
 * @param name - Template name (determines the default `.hbs` filename).
 * @param override - Absolute path to a custom template file, or `undefined`.
 * @returns Compiled template delegate.
 * @throws If the template file cannot be read.
 */
function loadTemplate(
  env: typeof Handlebars,
  name: TemplateName,
  override: string | undefined,
): HandlebarsTemplateDelegate {
  const path = override ?? resolve(TEMPLATES_DIR, `${name}.hbs`);
  const source = readFileSync(path, "utf-8");
  return compileTemplate(env, source);
}

// ---------------------------------------------------------------------------
// Per-element text renderers
// ---------------------------------------------------------------------------

/**
 * Renders a single class property declaration, including JSON serialization
 * attributes and an optional doc comment line.
 *
 * @param prop - Property view model.
 * @returns Multi-line C# property text (no trailing newline).
 */
function classPropertyText(prop: PropertyView): string {
  const parts: string[] = [];
  if (prop.doc) parts.push(prop.doc);
  parts.push(`[JsonPropertyName("${prop.jsonName}")]`);
  if (prop.nullable) parts.push(`[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]`);
  parts.push(`public ${prop.type} ${prop.name} { get; set; }`);
  return parts.join("\n");
}

/**
 * Renders a single interface property declaration (no access modifier),
 * including JSON serialization attributes and an optional doc comment line.
 *
 * @param prop - Property view model.
 * @returns Multi-line C# property text (no trailing newline).
 */
function interfacePropertyText(prop: PropertyView): string {
  const parts: string[] = [];
  if (prop.doc) parts.push(prop.doc);
  parts.push(`[JsonPropertyName("${prop.jsonName}")]`);
  if (prop.nullable) parts.push(`[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]`);
  parts.push(`${prop.type} ${prop.name} { get; set; }`);
  return parts.join("\n");
}

/**
 * Renders a single enum member line.
 *
 * @param member - Enum member view model.
 * @param isLast - Whether this is the last member (controls trailing comma).
 * @returns Single-line C# enum member text.
 */
/**
 * Renders a single enum member block: optional doc comment, `[EnumMember]`
 * attribute, and the member declaration with optional numeric value.
 *
 * @param member - Enum member view model.
 * @param isLast - Whether this is the last member (controls trailing comma).
 * @returns Multi-line C# enum member text (no trailing newline).
 */
function enumMemberText(member: EnumMemberView, isLast: boolean): string {
  const parts: string[] = [];
  if (member.doc) parts.push(member.doc);
  parts.push(`[EnumMember(Value = "${member.memberValue}")]`);
  const numericValue = typeof member.value === "number" ? ` = ${member.value}` : "";
  parts.push(`${member.name}${numericValue}${isLast ? "" : ","}`);
  return parts.join("\n");
}

/**
 * Renders a single controller action parameter declaration, including the
 * ASP.NET Core binding attribute.
 *
 * @param p - Parameter view model.
 * @returns Inline C# parameter declaration string, e.g. `[FromRoute] string id`.
 */
function operationParamDecl(p: OperationParamView): string {
  return `[${p.binding}] ${p.optional ? `${p.type}?` : p.type} ${p.name}`;
}

/**
 * Renders a complete controller action block: optional doc comment, one
 * `[HttpVerb("route")]` attribute per version route, and the `abstract`
 * method signature.
 *
 * @param op - Operation view model.
 * @returns Multi-line indented C# action text (no trailing newline).
 */
function controllerActionBlock(op: OperationView): string {
  const lines: string[] = [];
  if (op.doc) lines.push(...op.doc.split("\n").map((l) => `    ${l}`));
  for (const route of op.routes) {
    lines.push(`    [Http${op.httpVerb}("${route}")]`);
  }
  const paramList = op.params.map(operationParamDecl).join(", ");
  lines.push(`    public abstract Task<IActionResult> ${op.name}(${paramList});`);
  return lines.join("\n");
}

/**
 * Renders a single service interface method declaration.
 *
 * When `op.returnType` is `"void"` the method returns a plain `Task` with no
 * type parameter (the operation has no response body).  Otherwise it returns
 * `Task<T?>`.
 *
 * @param op - Operation view model.
 * @returns Multi-line indented C# method declaration text (no trailing newline).
 */
function serviceMethodDecl(op: OperationView): string {
  const lines: string[] = [];
  if (op.doc) lines.push(...op.doc.split("\n").map((l) => `    ${l}`));
  const paramList = op.params.map((p) => `${p.optional ? `${p.type}?` : p.type} ${p.name}`).join(", ");
  const returnDecl = op.returnType === "void" ? "Task" : `Task<${op.returnType}?>`;
  lines.push(`    ${returnDecl} ${op.name}Async(${paramList});`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compiles all templates and returns a {@link Renderer} instance.
 *
 * Templates are compiled once at construction time; the returned renderer is
 * cheap to call repeatedly.  Any template name absent from `overrides` falls
 * back to the corresponding bundled `.hbs` file.
 *
 * @param overrides - Optional map of template names to custom file paths.
 * @returns A fully initialised renderer.
 * @throws If any template file (built-in or custom) cannot be read or parsed.
 */
export function createRenderer(overrides: TemplateOverrides = {}): Renderer {
  const env = createHandlebarsEnv();
  const fileTemplate = loadTemplate(env, "file", overrides.file);
  const classTemplate = loadTemplate(env, "class", overrides.class);
  const interfaceTemplate = loadTemplate(env, "interface", overrides.interface);
  const enumTemplate = loadTemplate(env, "enum", overrides.enum);
  const controllerTemplate = loadTemplate(env, "controller", overrides.controller);
  const serviceInterfaceTemplate = loadTemplate(
    env,
    "service-interface",
    overrides["service-interface"],
  );
  const mergePatchTemplate = loadTemplate(
    env,
    "merge-patch-value",
    overrides["merge-patch-value"],
  );
  const enumMemberConverterTemplate = loadTemplate(
    env,
    "enum-member-converter",
    overrides["enum-member-converter"],
  );

  return {
    renderFile(view) {
      return fileTemplate(view);
    },
    renderClass(view) {
      const bases = [view.baseClass, view.interfaceName].filter(Boolean) as string[];
      return classTemplate({
        ...view,
        bases: bases.join(", "),
        propertiesBlock: view.properties.map(classPropertyText).join("\n\n"),
      });
    },
    renderInterface(view) {
      return interfaceTemplate({
        ...view,
        baseClause: view.baseInterface ? ` : ${view.baseInterface}` : "",
        propertiesBlock: view.properties.map(interfacePropertyText).join("\n\n"),
      });
    },
    renderEnum(view) {
      const last = view.members.length - 1;
      return enumTemplate({
        ...view,
        membersBlock: view.members.map((m, i) => enumMemberText(m, i === last)).join("\n"),
      });
    },
    renderController(view) {
      const actionsBlock =
        view.operations.length > 0
          ? view.operations.map(controllerActionBlock).join("\n\n") + "\n"
          : "";
      return controllerTemplate({ ...view, actionsBlock });
    },
    renderServiceInterface(view) {
      const methodsBlock =
        view.operations.length > 0
          ? "\n" + view.operations.map(serviceMethodDecl).join("\n\n")
          : "";
      return serviceInterfaceTemplate({ ...view, methodsBlock });
    },
    renderMergePatchValue() {
      return mergePatchTemplate({});
    },
    renderEnumMemberConverter() {
      return enumMemberConverterTemplate({});
    },
  };
}
