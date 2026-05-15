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

## Helper file emission

The `MergePatchValue<T>` helper class is automatically emitted to the helpers directory whenever any `MergePatchUpdate` model is generated, regardless of the `emit-helpers` option setting. This ensures merge-patch models always have access to the required helper type.

Use the `helpers-output-dir` option to control where the helper is written (default: `Helpers/`).
