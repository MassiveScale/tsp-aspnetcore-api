using TypeSpec.Reflection;

namespace MassiveScale.AspNetCoreApi;

/**
 * Overrides the C# name for the emitted model or enum.
 *
 * Affects only the declared type name (class, interface, enum) in the generated
 * C# files. The `JsonPropertyName` attribute values, `EnumMember` values, and
 * how other types reference this type in property signatures are all unchanged.
 *
 * @param name The exact C# identifier to use in the generated output.
 *
 * @example
 * ```typespec
 * @serverName("PetRequest")
 * model Pet { name: string; }
 * ```
 */
extern dec serverName(target: Model | Enum | EnumMember | ModelProperty, name: valueof string);
