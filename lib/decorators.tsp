using TypeSpec.Reflection;

namespace MassiveScale.AspNetCoreApi;

/**
 * Overrides the C# name for the emitted model or model property.
 *
 * Affects only the declared type name (class, interface) or property identifier in
 * the generated C# files. The `JsonPropertyName` attribute values are unchanged.
 *
 * The value must be a valid C# identifier: letters, digits, and underscores only,
 * starting with a letter or underscore (optionally prefixed with `@`).
 *
 * @param name The exact C# identifier to use in the generated output.
 *
 * @example
 * ```typespec
 * @serverName("PetRequest")
 * model Pet { name: string; }
 * ```
 */
extern dec serverName(target: Model | ModelProperty, name: valueof string);
