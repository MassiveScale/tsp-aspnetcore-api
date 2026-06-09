# RFC 7396 Merge Patch

The emitter automatically generates support for [RFC 7396 Merge Patch](https://tools.ietf.org/html/rfc7396) semantics when TypeSpec models use the `MergePatchUpdate<T>` template from `@typespec/http`.

## How it works

When the PATCH body type in a TypeSpec operation is (or extends) `MergePatchUpdate<T>`, the emitter replaces that type with the generic `MergePatch<T>` helper in the generated controller and validator signatures. The `MergePatchUpdate<T>` model itself is **not** emitted as a separate C# class — the helper handles the entire merge-patch contract.

This design means:

- Controllers receive `MergePatch<Widget>` instead of a generated `WidgetMergePatchUpdate` class.
- Validators test `IsDefined` / `IsNull` to distinguish "field absent" from "field explicitly null".
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

    // Names of all properties that were explicitly sent in the payload.
    public IEnumerable<string> DefinedProperties { get; }
}
```

## Applying the patch

The helper does not apply patches automatically. Use `IsDefined` and `TryGetValue` to copy only the fields the client sent:

```csharp
var entity = await repository.GetAsync(id);

if (body.TryGetValue<string>("name", out var name)) entity.Name = name!;
if (body.TryGetValue<int>("weight", out var weight)) entity.Weight = weight!.Value;

await repository.SaveAsync(entity);
```

Using `IsDefined` instead of `TryGetValue` lets you handle null-clear operations (RFC 7396 semantics: a `null` value removes the field):

```csharp
if (body.IsDefined("name"))
    entity.Name = body.IsNull("name") ? null : body.GetString("name")!;
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

## Helper file emission

`MergePatch.g.cs` is automatically emitted into the helpers directory whenever a `MergePatchUpdate` body type is encountered, regardless of the `emit-helpers` option. The `helpers-output-dir` option controls where the file is written (default: `Helpers/`).
