# FluentValidation Validators

When `emit-validators: true`, the emitter generates [FluentValidation](https://docs.fluentvalidation.net/) validator classes for models that appear as POST or PATCH request bodies, plus a `ValidatorsInitializer.g.cs` helper to register them with ASP.NET Core's DI container.

## Generated files

| File                         | Content                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `{Model}Validator.g.cs`      | `AbstractValidator<{Model}>` with rules for POST bodies.                                |
| `{Model}PatchValidator.g.cs` | Patch-aware `AbstractValidator<{Model}MergePatchUpdate>` whose rules fire only when the corresponding property is present in the patch body. |
| `ValidatorsInitializer.g.cs` | Static `AddGeneratedValidators(this IServiceCollection)` extension method for DI setup. |

## Setup

Enable in `tspconfig.yaml`:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    emit-validators: true
```

Register in your `Program.cs` or `Startup.cs`:

```csharp
builder.Services.AddGeneratedValidators();
```

## Extracted rules

The emitter reads TypeSpec constraint decorators and translates them to FluentValidation rules:

| TypeSpec decorator             | FluentValidation rule                            |
| ------------------------------ | ------------------------------------------------ |
| Required non-optional `string` | `NotEmpty()`                                     |
| `@minLength(n)`                | `MinimumLength(n)`                               |
| `@maxLength(n)`                | `MaximumLength(n)`                               |
| `@pattern("...")`              | `Matches(@"...")`                                |
| `@format("email")`             | `EmailAddress()`                                 |
| `@minValue(n)`                 | `GreaterThanOrEqualTo(n)`                        |
| `@maxValue(n)`                 | `LessThanOrEqualTo(n)`                           |
| Enum property                  | `IsInEnum()`                                     |
| Nested model property          | `SetValidator(childValidator)` (injected via DI) |

Properties marked `@visibility(Lifecycle.Read)` (read-only) are excluded from generated POST and PATCH validators.

## Custom rules

Every generated validator is a `partial class` that exposes a virtual `ExtendRules()` method. Override it in a hand-written partial to add custom rules without editing the generated file:

```csharp
public partial class WidgetValidator
{
    protected override void ExtendRules()
    {
        RuleFor(x => x.Name).Must(name => !name.Contains("admin")).WithMessage("Name cannot contain 'admin'.");
    }
}
```

## Version strategies

When the TypeSpec spec uses `@versioned`, the `validators-version-strategy` option controls output:

| Strategy        | Behaviour                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earliest`      | Emits validators using only the constraints present in the earliest API version.                                                                                                                                      |
| `latest`        | Emits validators using the constraints of the latest version. Emits a compiler warning.                                                                                                                               |
| `per-version`   | Emits a separate set of validator files per version, each in its own subdirectory.                                                                                                                                    |
| `version-aware` | (Default when `@versioned` is present) Emits one validator per model; rules for later-added properties are wrapped in `When(() => IsAtLeast("v2", ...))` guards that read the API version from the live HTTP request. |

Version-aware validators accept `IHttpContextAccessor` to resolve the API version from the route segment (`version`), the `api-version` request header, or the `api-version` query parameter. Ensure `services.AddHttpContextAccessor()` is called before `AddGeneratedValidators()`.

## Related options

| Option                        | Default        | Description                                                          |
| ----------------------------- | -------------- | -------------------------------------------------------------------- |
| `emit-validators`             | `false`        | Enable validator generation.                                         |
| `validators`                  | `"both"`       | Which validator types to emit: `"post"`, `"patch"`, or `"both"`.     |
| `validators-output-dir`       | `"Validators"` | Output directory for validator and initializer files.                |
| `validators-root-namespace`   | _(global root)_ | Root namespace for validator files.                                  |
| `validators-version-strategy` | _(auto)_       | Version strategy. Auto-detected from spec; see table above.          |
