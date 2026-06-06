using TypeSpec.Reflection;

namespace MassiveScale.AspNetCoreApi;

/**
 * Overrides the C# name for the emitted model, enum member, or model property.
 *
 * Affects only the declared type name (class, interface) or member identifier in
 * the generated C# files. The `JsonPropertyName` attribute values, `EnumMember`
 * values, and how other types reference a model in property signatures are all
 * updated to use the server name.
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
extern dec serverName(target: Model | EnumMember | ModelProperty, name: valueof string);
