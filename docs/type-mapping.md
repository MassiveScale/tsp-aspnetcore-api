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
