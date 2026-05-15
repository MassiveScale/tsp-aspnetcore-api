/**
 * @module utils
 *
 * Shared type-mapping tables and string-transformation utilities used by both
 * the emitter and controller collection modules.
 *
 * Centralising these here ensures that any change to a type mapping or a
 * naming convention only needs to happen in one place.
 */

/**
 * Maps TypeSpec built-in scalar names to their C# primitive type equivalents.
 *
 * Custom scalars that derive from a built-in walk this map up their base-scalar
 * chain; unmapped scalars fall back to `"object"`.
 */
export const SCALAR_MAP: Record<string, string> = {
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

/**
 * Maps TypeSpec `@format` annotation values to their C# type equivalents.
 *
 * Matched case-insensitively; an unrecognised format string falls through to
 * the scalar-type mapping.
 */
export const FORMAT_MAP: Record<string, string> = {
  uuid: "Guid",
  guid: "Guid",
  uri: "Uri",
  url: "Uri",
  "date-time": "DateTimeOffset",
  date: "DateOnly",
  time: "TimeOnly",
};

/**
 * Converts a string to PascalCase by splitting on `_`, `-`, and whitespace
 * and capitalising the first letter of each segment.
 *
 * @param name - Input string (e.g. `"user_id"`, `"first-name"`).
 * @returns PascalCase string (e.g. `"UserId"`, `"FirstName"`).
 */
export function pascalCase(name: string): string {
  if (!name) return name;
  return name
    .split(/[_\-\s]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("");
}

/**
 * Converts a string to camelCase by PascalCasing it then lower-casing the
 * first character.
 *
 * @param name - Input string (e.g. `"UserId"`, `"first_name"`).
 * @returns camelCase string (e.g. `"userId"`, `"firstName"`).
 */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}
