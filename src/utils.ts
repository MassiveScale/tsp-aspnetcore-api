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

/** Short C# escape sequences for characters that cannot appear raw in a string literal. */
const CSHARP_STRING_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\0": "\\0",
  "\x07": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};

/** Code points C# treats as line breaks besides `\r` / `\n`: NEL, LS and PS. */
const CSHARP_EXTRA_LINE_BREAKS = new Set([0x85, 0x2028, 0x2029]);

/**
 * Converts a string to a C# regular string literal, escaping backslashes,
 * quotes, and every control or line-terminator character. A raw newline (or
 * U+0085 / U+2028 / U+2029, which C# also treats as line breaks) inside a
 * regular string literal is a compile error.
 *
 * @param value - The string to encode.
 * @returns A quoted C# string literal, e.g. `"line1\nline2"`.
 */
export function csharpStringLiteral(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const short = CSHARP_STRING_ESCAPES[char];
    if (short) {
      escaped += short;
    } else if (
      code < 0x20 ||
      code === 0x7f ||
      CSHARP_EXTRA_LINE_BREAKS.has(code)
    ) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += char;
    }
  }
  return `"${escaped}"`;
}

/**
 * Returns the body of {@link csharpStringLiteral} without the surrounding
 * quotes, for templates that already write the quotes themselves
 * (`IsDefined("{{{jsonName}}}")`).
 *
 * @param value - The string to encode.
 * @returns The escaped text, e.g. `line1\nline2`.
 */
export function csharpStringContent(value: string): string {
  return csharpStringLiteral(value).slice(1, -1);
}

/**
 * Escapes a string for a C# verbatim string literal (`@"..."`), where the only
 * escape is a doubled quote.
 *
 * @param value - The string to encode.
 * @returns The text with every `"` written as `""`.
 */
export function csharpVerbatimStringContent(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * Escapes the characters that are significant in XML text (`&`, `<`, `>`), so
 * plain documentation text cannot break an XML doc comment.
 *
 * @param text - Plain text.
 * @returns The text with `&`, `<` and `>` replaced by entity references.
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
