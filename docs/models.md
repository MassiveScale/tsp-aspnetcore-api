# Model Generation

## Which models get a class

A C# class is emitted only for **data**: models that are actually sent or received as an HTTP payload. The emitter decides this by asking `@typespec/http` how each operation's request and response bodies resolve, rather than emitting every model in the TypeSpec program.

TypeSpec calls `@statusCode`, `@header`, `@cookie`, `@query` and `@path` properties [metadata](https://typespec.io/docs/libraries/http/operations/). Two kinds of model describe HTTP details rather than data:

- A **metadata-only model** has only metadata properties, e.g. `OkResponse`, `NotFoundResponse`, `model ETagHeader { @header("ETag") etag: string; }`, or a model of `@path` / `@query` parameters. It has no data shape and is **never emitted**. When spread into an operation (`...IfMatchHeader`) its properties become controller parameters (see [Controllers and Services](./controllers-and-services.md#return-types-and-response-models)).
- A **response model** is a model used as an operation response that contains metadata. Only its body is data:
  - **Explicit body.** With an `@body` or `@bodyRoot` property (`model EntityResponse<T> { ...OkResponse; ...ETagHeader; @body body: T; }`), the response model is **not emitted**. The body type (`T`) is emitted instead, and the service returns it.
  - **Implicit body.** If a response model mixes metadata with plain properties and has no `@body`, the plain properties form the body. The model **is** emitted under its own name, **without its metadata properties**, and the service returns that class:

```typespec
model WidgetResult {
  @header("ETag") etag: string; // metadata: omitted from the class
  name: string;                 // body
}

@get read(): WidgetResult;
```

```csharp
public partial class WidgetResult
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }
}

// IWidgetsService
Task<WidgetResult?> ReadAsync(CancellationToken cancellationToken);
```

If the same model is also used somewhere metadata doesn't apply (for example as a property type of another payload), every property is kept.

### Reachability

When the program has HTTP operations, a model gets a class if it is reachable from an operation payload:

- a request body, a response body (as resolved above), or a parameter type;
- transitively, a property type, base model, array/record element, union variant, or `MergePatchUpdate<T>` source of one of those;
- every derived model of a `@discriminator` base that is reachable, since polymorphic JSON needs them.

Models that no operation reaches are **not** emitted, and neither are non-discriminated derived models that are never used directly. `@error` models are emitted when they are a body (e.g. `Problem` in `@error model NotFoundError { ...NotFoundResponse; @body body: Problem; }`). [Validators](./validators.md) follow the same rule: they are only emitted for models that get a class.

When the program has **no** HTTP operations (a models-only library), every model is emitted except metadata-only models and explicit-body response models.

Enums are always emitted, whether or not they are reachable.

### Template instances

A templated model that is itself a payload (e.g. `PagedResult<T>` used directly as a body or property type) gets **one distinct class per instantiation**. The class name is the template name followed by each template argument's name:

| TypeSpec                                                              | C# class                    |
| --------------------------------------------------------------------- | --------------------------- |
| `PagedResult<Widget>`                                                 | `PagedResultWidget`         |
| `PagedResult<Gadget>`                                                 | `PagedResultGadget`         |
| `PagedResult<Widget[]>`                                               | `PagedResultWidgetList`     |
| `PagedResult<Record<Widget>>`                                         | `PagedResultWidgetMap`      |
| `Box<string>` / `Box<Cat \| Dog>`                                     | `BoxString` / `BoxCatOrDog` |
| `@friendlyName("{name}Page", T) model Page<T>` with `Page<Widget>`    | `WidgetPage`                |
| `@serverName("Page") model PagedResult<T>` with `PagedResult<Widget>` | `PageWidget`                |

Generic C# classes (`PagedResult<T>`) are not emitted, because a TypeSpec template can reshape properties per argument in ways a C# type parameter cannot express. Inferred enums on a template instance are named after the instance (`BoxShadeValue`), so instantiations never share an enum.

`model WidgetList is PagedResult<Widget>` is a new named model, not a template instance, so it is emitted as `WidgetList`.

## Default property values

When a TypeSpec model property carries a default value, the emitter assigns it as a C# property initializer. The following value kinds are supported:

| TypeSpec default                        | C# initializer                 |
| --------------------------------------- | ------------------------------ |
| Enum member (`Size.medium`)             | `Size.Medium`                  |
| String literal (`"production"`)         | `"production"`                 |
| Numeric literal (`20`)                  | `20`                           |
| Numeric literal on `decimal` (`9.99`)   | `9.99m`                        |
| Numeric literal on `float32` (`0.5`)    | `0.5f`                         |
| Boolean literal (`true`)                | `true`                         |
| Array value (`#[1000, 2500]`)           | `new List<int> { 1000, 2500 }` |
| Empty array value (`#[]`)               | `new List<int>()`              |
| Nested array value (`#[#[1, 2], #[3]]`) | `new List<IList<int>> { ... }` |

```typespec
enum Size { small, medium, large }

model Widget {
  size: Size = Size.medium;
  pageSize: int32 = 20;
  env: string = "production";
  enabled: boolean = true;
  buckets?: int32[] = #[1000, 2500, 5000];
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

    [JsonPropertyName("buckets")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<int>? Buckets { get; set; } = new List<int> { 1000, 2500, 5000 };
}
```

Array defaults must use TypeSpec's array-value syntax `#[...]`. A bare `[...]` is a tuple _type_, and the TypeSpec compiler rejects it as a default with `expect-value: Is a tuple type, but is being used as a value here`. Array elements may be any supported value kind, including enum members, `null` (for nullable element types), and nested arrays.

Object values (`#{...}`), scalar constructors, and arrays containing either are not supported and produce no initializer.

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
