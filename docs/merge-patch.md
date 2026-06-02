# RFC 7396 Merge Patch

The emitter automatically generates support for [RFC 7396 Merge Patch](https://tools.ietf.org/html/rfc7396) semantics when TypeSpec models use the `MergePatchUpdate<T>` template from `@typespec/http`.

## MergePatchValue\<T\> wrapper

For models that implement `MergePatchUpdate<T>`, all properties are wrapped in `MergePatchValue<T>` to distinguish between:

- **Property not provided** — `MergePatchValue<T>.Absent` (omitted from JSON)
- **Property explicitly set to null** — `MergePatchValue<T>.Of(null)` (serialized as JSON `null`)

This distinction is necessary because RFC 7396 treats missing properties differently from null values during merge operations.

## Naming convention

Models must follow the standard `@typespec/http` naming convention: the model name **must end with `MergePatchUpdate`** (case-insensitive). The `@typespec/http` library automatically generates models named `{ResourceName}MergePatchUpdate` when you use `MergePatchUpdate<ResourceType>` in operation parameters or response types.

## Example

```typespec
import "@typespec/http";
using TypeSpec.Http;

namespace MyApi;

model Widget {
  id: string;
  name: string;
  weight: int32;
}

model WidgetMergePatchUpdate is MergePatchUpdate<Widget>;

@route("/widgets/{id}")
@patch
op updateWidget(@path id: string, @body patch: WidgetMergePatchUpdate): Widget;
```

Generated C#:

```csharp
public partial class WidgetMergePatchUpdate : IWidgetMergePatchUpdate
{
    [JsonPropertyName("id")]
    public MergePatchValue<string?> Id { get; set; } = MergePatchValue<string?>.Absent;

    [JsonPropertyName("name")]
    public MergePatchValue<string?> Name { get; set; } = MergePatchValue<string?>.Absent;

    [JsonPropertyName("weight")]
    public MergePatchValue<int?> Weight { get; set; } = MergePatchValue<int?>.Absent;
}
```

## Patch method

Each generated MergePatch class includes a `Patch(TEntity target)` method that applies the patch in-place, similar to the `Delta<T>.Patch()` method from `Microsoft.AspNetCore.OData`.

```csharp
var patch = await JsonSerializer.DeserializeAsync<WidgetMergePatchUpdate>(requestBody);
var entity = await repository.GetAsync(id);
patch.Patch(entity);
await repository.SaveAsync(entity);
```

Only properties that were **explicitly set** in the JSON payload (i.e. `IsPresent == true`) are copied to the target entity. Properties that were absent from the payload are left unchanged.

### Type-compatible properties

The emitter compares the inner type of each `MergePatchValue<T>` property against the corresponding property type on the source entity. Properties whose types match exactly are included in the generated assignments:

```csharp
public void Patch(Widget target)
{
    if (Name.IsPresent) target.Name = Name.Value;
    if (Weight.IsPresent) target.Weight = Weight.Value;
}
```

### Skipped properties

Properties where the MergePatch inner type differs from the entity property type are excluded from the generated assignments. The most common case is nested-model array properties, where the patch model uses a `ReplaceOnly` variant (e.g. `IList<TagMergePatchUpdateReplaceOnly>?`) while the entity uses the original type (e.g. `IList<Tag>?`).

A comment is generated to identify each skipped property and explain the mismatch, so developers know exactly what to handle manually:

```csharp
public void Patch(Pet target)
{
    if (Name.IsPresent) target.Name = Name.Value;
    if (PhotoUrls.IsPresent) target.PhotoUrls = PhotoUrls.Value;
    // The following properties were not applied because the MergePatch inner type
    // differs from the entity property type. Handle them manually after calling Patch():
    //   Tags (patch inner: IList<TagMergePatchUpdateReplaceOnly>? vs entity: IList<Tag>?)
    //   Status (patch inner: object? vs entity: PetStatus?)
}
```

## Helper file emission

The `MergePatchValue<T>` helper class is automatically emitted to the helpers directory whenever any `MergePatchUpdate` model is generated, regardless of the `emit-helpers` option setting. This ensures merge-patch models always have access to the required helper type.

Use the `helpers-output-dir` option to control where the helper is written (default: `Helpers/`).
