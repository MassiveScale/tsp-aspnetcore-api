# Type Mapping

## TypeSpec to C#

| TypeSpec                                 | C#                                   |
| ---------------------------------------- | ------------------------------------ |
| `string`                                 | `string`                             |
| `boolean`                                | `bool`                               |
| `bytes`                                  | `byte[]`                             |
| `int8` / `int16` / `int32` / `int64`     | `sbyte` / `short` / `int` / `long`   |
| `uint8` / `uint16` / `uint32` / `uint64` | `byte` / `ushort` / `uint` / `ulong` |
| `safeint`, `integer`                     | `long`                               |
| `float32`                                | `float`                              |
| `float`, `float64`, `numeric`            | `double`                             |
| `decimal`, `decimal128`                  | `decimal`                            |
| `plainDate`                              | `DateOnly`                           |
| `plainTime`                              | `TimeOnly`                           |
| `utcDateTime`, `offsetDateTime`          | `DateTimeOffset`                     |
| `duration`                               | `TimeSpan`                           |
| `url`                                    | `Uri`                                |
| `T[]`                                    | `IList<T>`                           |
| `Record<T>`                              | `IDictionary<string, T>`             |
| `T \| null`                              | `T?`                                 |
| Other unions, tuples                     | `object`                             |

Custom scalars walk up to the nearest known base type. Unmapped scalars fall back to `object`.

## `@format` overrides

When a property or scalar carries `@format(...)`, the format takes precedence over the underlying type:

| `@format` value | C#               |
| --------------- | ---------------- |
| `uuid`, `guid`  | `Guid`           |
| `uri`, `url`    | `Uri`            |
| `date-time`     | `DateTimeOffset` |
| `date`          | `DateOnly`       |
| `time`          | `TimeOnly`       |

Unknown format strings fall through to the underlying type mapping.

## `@encode` encodings

The built-in TypeSpec `@encode` decorator changes how a value is represented on the wire. When it is present on a property (or its scalar type), the emitter adjusts the C# type and/or adds `System.Text.Json` serialization attributes:

| TypeSpec                                                            | Emitted C#                                                                          | Notes                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `@encode("unixTimestamp", int32)` on `utcDateTime`/`offsetDateTime` | `int`                                                                               | Epoch seconds; use `int64` for `long`.              |
| `@encode("seconds", int32)` on `duration`                           | `int`                                                                               | Use `float64` for `double`, etc.                    |
| `@encode(string)` on a numeric (`int64`, `decimal`, …)              | same numeric type + `[JsonNumberHandling(AllowReadingFromString \| WriteAsString)]` | Reads/writes the number as a JSON string.           |
| `@encode(string)` on `boolean`                                      | `bool` + `[JsonConverter(typeof(<Helpers>.BooleanStringJsonConverter))]`            | Serializes as `"true"`/`"false"` (TypeSpec 1.14.0). |

An `@encode` type override takes precedence over `@format` and the default scalar mapping; nullability is applied as usual. Custom scalars are canonicalized to their nearest built-in base before matching. The `BooleanStringJsonConverter` helper is emitted automatically into the helpers directory when needed (overridable via the [`bool-string-converter` template](custom-templates.md)). Encodings other than those listed above leave the default type mapping unchanged.

```typespec
model Event {
  @encode("unixTimestamp", int64) occurredAt: utcDateTime; // long
  @encode("seconds", int32) ttl: duration;                 // int
  @encode(string) balance: int64;                          // long + [JsonNumberHandling]
  @encode(string) active: boolean;                         // bool + [JsonConverter]
}
```
