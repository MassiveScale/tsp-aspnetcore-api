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

/**
 * Sets what a JSON Merge Patch body does with an object sent for this property, which
 * must hold a single model.
 *
 * - `"merge"` — RFC 7396: the object is merged into the current value. Only the members it
 *   sends change, and the PATCH validator checks it as a partial patch.
 * - `"replace"` — the object replaces the current value. Members it leaves out are cleared,
 *   and the PATCH validator checks it as a complete model with the model's POST validator.
 *
 * Overrides the `merge-patch-nested-models` emitter option, which defaults to `"merge"`.
 * Arrays always replace, and records always merge key by key, so the decorator has no
 * effect on them.
 *
 * @param strategy `"merge"` or `"replace"`.
 *
 * @example
 * ```typespec
 * model QuotaGroup {
 *   @patchStrategy("replace")
 *   targeting: Targeting;
 * }
 * ```
 */
extern dec patchStrategy(
  target: ModelProperty,
  strategy: valueof "merge" | "replace"
);
