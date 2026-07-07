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

## @discriminator

TypeSpec's built-in `@discriminator` decorator marks a base model as polymorphic. The emitter resolves every derived model down to a concrete wire value and emits `[JsonPolymorphic]` / `[JsonDerivedType]` attributes so System.Text.Json can (de)serialize the hierarchy through the base type.

```typespec
@discriminator("kind")
model Pet {
  kind: string;
  name: string;
}

model Dog extends Pet {
  kind: "dog";
}

model Cat extends Pet {
  kind: "cat";
}
```

```csharp
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(Cat), "cat")]
[JsonDerivedType(typeof(Dog), "dog")]
public abstract partial class Pet
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }
}

public partial class Dog : Pet
{
}
```

`[JsonDerivedType]` attributes are sorted by discriminator value for stable output, and intermediate models with no discriminator value of their own are skipped in favor of their nearest descendant that has one.

The base class itself (`Pet` above) is always emitted `abstract`. It has no discriminator value of its own — only its derived types do — so instantiating it directly would produce an object with no valid wire representation. Derived classes are unaffected and remain concrete. This works transparently with polymorphic (de)serialization and FluentValidation's `SetInheritanceValidator` dispatch (see [FluentValidation validators](validators.md)), since neither needs to construct the base type directly.

The discriminator property may be typed as `string`, a string-literal union, or an `enum` whose members carry string values (or no value, in which case the member name is used) — TypeSpec resolves the wire value the same way for all three. Enum members with a **numeric** value are rejected by the TypeSpec compiler itself with an `invalid-discriminator-value` diagnostic, since the discriminator must resolve to a string.

```typespec
enum PetKind { Dog: "dog", Cat: "cat" }

@discriminator("kind")
model Pet {
  kind: PetKind;
  name: string;
}

model Dog extends Pet {
  kind: PetKind.Dog;
}
```

The discriminator property (`kind` above) is **omitted from the generated class and companion interface everywhere in the hierarchy** — it is never a declared C# property, only polymorphic JSON metadata. This is intentional: System.Text.Json throws (or, on older runtimes, silently produces invalid duplicate JSON) when a declared property's wire name collides with `TypeDiscriminatorPropertyName`. The runtime type carries the discriminator information instead.

## @serverName

The `@serverName` decorator overrides the C# identifier for a model or model property. Import the package and open the namespace to use it:

```typespec
import "@massivescale/tsp-aspnetcore-api";
using MassiveScale.AspNetCoreApi;
```

The value must be a valid C# identifier: letters, digits, and underscores only, starting with a letter or underscore (optionally prefixed with `@` to escape a reserved keyword). Names containing path separators, spaces, or other punctuation are rejected with a compile-time diagnostic. Bare C# reserved keywords (e.g. `class`, `string`, `int`) are also rejected — prefix with `@` to form a verbatim identifier (e.g. `@class`).

> **Note:** `@serverName` is **not** supported on `enum` types or `enum` members. Use it on `model` or `model property` targets only. Applying it to an unsupported target produces a TypeSpec compiler error.

**Targets and effects:**

| Target           | What changes                                                                            | What stays the same                    |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `model`          | Class name, companion interface (`I<Name>`), file names, all references in other models | `[JsonPropertyName("...")]` wire names |
| `model property` | C# property identifier                                                                  | `[JsonPropertyName("...")]` wire name  |

```typespec
@serverName("PetRequest")
model Pet {
  @serverName("Identifier")
  id: string;
  ownerName: string;
}

enum Status {
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
  Active,

    [EnumMember(Value = "inactive")]
    Inactive,
}
```

When a model is renamed with `@serverName`, all references to it — including base class declarations and property types in other models — automatically use the server name in the generated C#.

## Cross-namespace references

Every reference to an emitted model, interface, or enum — base classes, property types (including inside `IList<T>`, `IDictionary<string, T>`, and unions), companion-interface implementations, discriminator `[JsonDerivedType(typeof(...))]` attributes, and `MergePatch<T>` — is always written as a fully-qualified C# type name (e.g. `Demo.Models.Widget`, `Demo.Helpers.MergePatch<Demo.Models.Widget>`), never a bare name paired with a `using` directive. This holds even when the reference is within the same namespace.

Generated files therefore never depend on `using` resolution to compile, which avoids ambiguous- or missing-reference errors when `models-namespace`, `controllers-namespace`, `services-namespace`, `validators-namespace`, and `helpers-namespace` differ (the default configuration).
