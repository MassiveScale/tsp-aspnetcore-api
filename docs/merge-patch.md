# RFC 7396 Merge Patch

The emitter automatically generates support for [RFC 7396 Merge Patch](https://tools.ietf.org/html/rfc7396) semantics when TypeSpec models use the `MergePatchUpdate<T>` template from `@typespec/http`.

## How it works

When the PATCH body type in a TypeSpec operation is (or extends) `MergePatchUpdate<T>`, the emitter replaces that type with the generic `MergePatch<T>` helper in the generated controller and validator signatures. The `MergePatchUpdate<T>` model itself is **not** emitted as a separate C# class — the helper handles the entire merge-patch contract.

This design means:

- Controllers receive `MergePatch<Widget>` instead of a generated `WidgetMergePatchUpdate` class.
- Validators use `IsDefined` / `IsNull` to distinguish "field absent" from "field explicitly null".
- A single shared helper handles all entity types — no per-model boilerplate.

## TypeSpec usage

```typespec
import "@typespec/http";
using TypeSpec.Http;

namespace MyApi;

model Widget {
  id: string;
  name: string;
  weight: int32;
}

model WidgetPatch is MergePatchUpdate<Widget>;

@route("/widgets/{id}")
interface Widgets {
  @patch update(@path id: string, @body body: WidgetPatch): Widget;
}
```

## Generated controller signature

```csharp
[HttpPatch("{id}")]
public abstract Task<IActionResult> Update(
    [FromRoute] string id,
    [FromBody] MergePatch<Widget> body,
    CancellationToken cancellationToken);
```

The `WidgetPatch` name never appears in generated C# output. Any model whose TypeSpec name ends with `MergePatchUpdate` (case-insensitive) is detected as a merge-patch body and mapped to `MergePatch<T>`.

## `MergePatch<T>` API

The helper class is emitted into the helpers directory and exposes these members:

```csharp
public class MergePatch<T>
{
    // Raw JSON payload, keyed by property name (case-insensitive).
    [JsonExtensionData]
    public Dictionary<string, JsonElement> Properties { get; init; }

    // True when the property was present in the JSON payload (even if null).
    public bool IsDefined(string propertyName);

    // True when the property is present and its value is JSON null.
    public bool IsNull(string propertyName);

    // Returns the string value of a property, or null when absent or null.
    public string? GetString(string propertyName);

    // Attempts to deserialize a property to TValue.
    // Returns true when the property is present (even if its value is null).
    public bool TryGetValue<TValue>(string propertyName, out TValue? value,
        JsonSerializerOptions? options = null);

    // Names of all properties explicitly sent in the payload.
    public IEnumerable<string> DefinedProperties { get; }

    // Same as DefinedProperties; provided as a method for use in LINQ chains.
    public IEnumerable<string> GetChangedPropertyNames();

    // Gets the declared System.Type of the named property on T via reflection.
    // Returns false when T has no matching public instance property.
    public bool TryGetPropertyType(string name, out Type? type);

    // Gets the patch value for the named property, deserialized to T's
    // declared property type via reflection.
    // Returns false when the property is absent from the patch, T has no
    // such property, or deserialization fails.
    public bool TryGetPropertyValue(string name, out object? value,
        JsonSerializerOptions? options = null);

    // Serializes value and stores it as a patch entry for the named property.
    // Pass null to mark the field for clearing (RFC 7396 semantics).
    // Returns false when serialization fails.
    public bool TrySetPropertyValue(string name, object? value,
        JsonSerializerOptions? options = null);

    // Constructs a MergePatch<T> from a raw JSON string. Every property
    // present in the JSON is treated as explicitly defined in the patch.
    // Keys reflect JSON wire names, not C# property names.
    public static MergePatch<T> FromJson(string json,
        JsonSerializerOptions? options = null);

    // Constructs a MergePatch<T> from an existing T instance by serializing
    // it to JSON. All serialized properties are treated as explicitly defined.
    // Respects options.DefaultIgnoreCondition — pass null options to include
    // all properties regardless of value.
    public static MergePatch<T> From(T entity,
        JsonSerializerOptions? options = null);

    // Applies all defined patch properties to original via reflection.
    // Each property is deserialized to T's declared type and written back.
    // Properties absent from T, that cannot be deserialized, or that are
    // read-only are silently skipped.
    public void Patch(T original, JsonSerializerOptions? options = null);

    // Async variant of Patch. Applies the patch synchronously, then returns
    // ValueTask.CompletedTask. Throws OperationCanceledException if
    // cancellationToken is cancelled before work begins.
    public ValueTask PatchAsync(T original, JsonSerializerOptions? options = null,
        CancellationToken cancellationToken = default);
}
```

## Applying the patch

### Simple: `Patch` / `PatchAsync`

For straightforward use cases, call `Patch` (or `PatchAsync` in an async context) to apply all defined properties to the entity in one step:

```csharp
var entity = await repository.GetAsync(id);
await body.PatchAsync(entity, cancellationToken: cancellationToken);
await repository.SaveAsync(entity);
```

Both methods use reflection to match each JSON property name to a writable property on `T` (case-insensitive). Properties absent from `T`, read-only, or that cannot be deserialized are silently skipped. Pass a `JsonSerializerOptions` instance if custom converters are needed.

`PatchAsync` returns a `ValueTask` (no allocation on the hot path) and checks the cancellation token before starting work. The patch application itself is synchronous — `PatchAsync` exists for seamless composition in async controller actions.

### Fine-grained: `IsDefined` and `TryGetValue`

For precise control over individual fields — for example when you need to apply business logic per property or handle null-clear semantics differently:

```csharp
var entity = await repository.GetAsync(id);

if (body.TryGetValue<string>("name", out var name)) entity.Name = name!;
if (body.TryGetValue<int>("weight", out var weight)) entity.Weight = weight!.Value;

await repository.SaveAsync(entity);
```

Use `IsDefined` / `IsNull` when you need to distinguish "field absent" from "field explicitly set to null" (RFC 7396 clear-field semantics):

```csharp
if (body.IsDefined("name"))
    entity.Name = body.IsNull("name") ? null : body.GetString("name")!;
```

### Building a patch programmatically

**From a JSON string** — use `FromJson` when you already have a raw JSON payload:

```csharp
var patch = MergePatch<Widget>.FromJson("""{"name":"Sprocket","weight":42}""");
patch.Patch(entity);
```

**From an existing entity** — use `From` to build a patch that treats every serialized property as defined. Useful for seeding test scenarios or applying a full-object replace:

```csharp
var source = new Widget { Name = "Sprocket", Weight = 42 };
var patch = MergePatch<Widget>.From(source);
patch.Patch(entity);
```

> **Note:** `FromJson` and `From` key properties by their JSON wire names. If `T` uses `[JsonPropertyName]` attributes or a naming policy, those wire names may not match the C# property names used internally by `Patch` / `PatchAsync`. Use matching `JsonSerializerOptions` for both construction and application when custom naming is in play.

**Field by field** — use `TrySetPropertyValue` when constructing the patch incrementally:

```csharp
var patch = new MergePatch<Widget>();
patch.TrySetPropertyValue("name", "Sprocket");
patch.TrySetPropertyValue("weight", 42);
patch.TrySetPropertyValue("tag", null);   // RFC 7396 clear-field

patch.Patch(entity);
```

## Validator integration

The generated PATCH validator uses `IsDefined` to block read-only properties and enforce constraints only when a property is present:

```csharp
// Read-only property: reject if client tries to set it
this.RuleFor(x => x)
    .Must(x => !x.IsDefined("id"))
    .WithName("id")
    .WithMessage("'id' is read-only and cannot be modified.");

// Optional string constraint: only validate when the property is present
this.RuleFor(x => x)
    .Must(x => (x.GetString("name")?.Length ?? 0) > 0)
    .When(x => x.IsDefined("name") && !x.IsNull("name"))
    .WithName("name");
```

## Choosing a style: `merge-patch-style`

The `merge-patch-style` option controls whether the emitter uses a single shared generic helper or generates a separate class per entity.

| Style       | Default | Description                                                                                                          |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `"generic"` | ✓       | Emits one shared `MergePatch<T>` class in the helpers directory. All PATCH operations share this class via generics. |
| `"typed"`   |         | Emits a concrete `{Model}MergePatch` class per entity directly in the models directory. No generic helper is needed. |

Both styles expose the same API surface (`IsDefined`, `IsNull`, `Patch`, `PatchAsync`, `FromJson`, `From`, etc.).

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    merge-patch-style: typed
```

### Generic style (default)

```csharp
// Generated in Helpers/MergePatch.g.cs
public class MergePatch<T> { ... }

// Controller signature
public abstract Task<IActionResult> Update(
    [FromRoute] string id,
    [FromBody] MergePatch<Widget> body,
    CancellationToken cancellationToken);
```

### Typed style

```csharp
// Generated in Models/WidgetMergePatch.g.cs (alongside Widget.g.cs)
public class WidgetMergePatch { ... }

// Controller signature
public abstract Task<IActionResult> Update(
    [FromRoute] string id,
    [FromBody] WidgetMergePatch body,
    CancellationToken cancellationToken);
```

The typed style avoids a dependency on the helpers namespace in controllers and services — the `WidgetMergePatch` type lives in the same `models-namespace` as `Widget` itself. Validators follow the same type name: `AbstractValidator<WidgetMergePatch>`.

## Helper file emission

For `merge-patch-style: "generic"` (the default), `MergePatch.g.cs` is always emitted into the helpers directory regardless of the `emit-helpers` option. The `helpers-output-dir` option controls where the file is written (default: `Helpers/`).

For `merge-patch-style: "typed"`, no shared helper is emitted. Instead, one `{Model}MergePatch.g.cs` file is written into the models output directory for each entity that has a PATCH operation.
