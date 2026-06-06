# Model Generation

## Default property values

When a TypeSpec model property carries a default value, the emitter assigns it as a C# property initializer. The following value kinds are supported:

| TypeSpec default                | C# initializer |
| ------------------------------- | -------------- |
| Enum member (`Size.medium`)     | `Size.Medium`  |
| String literal (`"production"`) | `"production"` |
| Numeric literal (`20`)          | `20`           |
| Boolean literal (`true`)        | `true`         |

```typespec
enum Size { small, medium, large }

model Widget {
  size: Size = Size.medium;
  pageSize: int32 = 20;
  env: string = "production";
  enabled: boolean = true;
}
```

```csharp
public partial class Widget : IWidget
{
    [JsonPropertyName("size")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Size? Size { get; set; } = Size.Medium;

    [JsonPropertyName("pageSize")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? PageSize { get; set; } = 20;

    [JsonPropertyName("env")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Env { get; set; } = "production";

    [JsonPropertyName("enabled")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Enabled { get; set; } = true;
}
```

Complex default value kinds (objects, arrays, scalar constructors) are not supported and produce no initializer.

## Enums

TypeSpec `enum` declarations are emitted as C# enums. Each member can carry a `@doc` string and a custom JSON wire name via its string value.

```typespec
@doc("Traffic light state")
enum TrafficLight {
  @doc("Stop")    Red: "red";
  @doc("Caution") Yellow: "yellow";
  @doc("Go")      Green: "green";
}
```

```csharp
[JsonConverter(typeof(EnumMemberConverterFactory))]
public enum TrafficLight
{
    /// <summary>Stop</summary>
    [EnumMember(Value = "red")]
    Red,

    /// <summary>Caution</summary>
    [EnumMember(Value = "yellow")]
    Yellow,

    /// <summary>Go</summary>
    [EnumMember(Value = "green")]
    Green,
}
```

The `EnumMemberConverterFactory` helper is emitted once into `helpers-output-dir` (default `Helpers/`). It implements `JsonConverterFactory` and serializes each member using the `[EnumMember(Value = "...")]` attribute; when the attribute is absent, the field name is used verbatim. Deserialization is case-insensitive.

## @serverName

The `@serverName` decorator overrides the C# identifier for a model, enum member, or model property. Import the package and open the namespace to use it:

```typespec
import "@massivescale/tsp-aspnetcore-api";
using MassiveScale.AspNetCoreApi;
```

The value must be a valid C# identifier: letters, digits, and underscores only, starting with a letter or underscore (optionally prefixed with `@` to escape a reserved keyword). Names containing path separators, spaces, or other punctuation are rejected with a compile-time diagnostic.

> **Note:** `@serverName` is **not** supported on `enum` types. Use it on `model`, `enum member`, or `model property` targets only. Applying it to an enum produces a TypeSpec compiler error.

**Targets and effects:**

| Target           | What changes                                                                            | What stays the same                      |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| `model`          | Class name, companion interface (`I<Name>`), file names, all references in other models | `[JsonPropertyName("...")]` wire names   |
| `enum member`    | C# member identifier                                                                    | `[EnumMember(Value = "...")]` wire value |
| `model property` | C# property identifier                                                                  | `[JsonPropertyName("...")]` wire name    |

```typespec
@serverName("PetRequest")
model Pet {
  @serverName("Identifier")
  id: string;
  ownerName: string;
}

enum Status {
  @serverName("Running")
  active: "active";
  inactive: "inactive";
}
```

```csharp
// PetRequest.g.cs
public partial class PetRequest : IPetRequest
{
    [JsonPropertyName("id")]           // wire name unchanged
    public string? Identifier { get; set; }

    [JsonPropertyName("ownerName")]
    public string? OwnerName { get; set; }
}

// Status.g.cs
public enum Status
{
    [EnumMember(Value = "active")]     // wire value unchanged
    Running,

    [EnumMember(Value = "inactive")]
    Inactive,
}
```

When a model is renamed with `@serverName`, all references to it — including base class declarations and property types in other models — automatically use the server name in the generated C#.

## Cross-namespace references

When a model references a type from a different namespace, the corresponding `using` is added automatically. References inside `IList<T>`, `IDictionary<string, T>`, unions, and base classes are all tracked. The rewritten namespace from `namespace-map` is used in the generated `using` directive.
