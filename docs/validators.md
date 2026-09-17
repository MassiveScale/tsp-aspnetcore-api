# FluentValidation Validators

When `emit-validators: true`, the emitter generates [FluentValidation](https://docs.fluentvalidation.net/) validator classes for models that appear as POST or PATCH request bodies, plus a `ValidatorsInitializer.g.cs` helper to register them with ASP.NET Core's DI container.

## Generated files

| File                         | Content                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{Model}Validator.g.cs`      | `AbstractValidator<{Model}>` with rules for POST bodies.                                                                                 |
| `{Model}PatchValidator.g.cs` | Patch-aware `AbstractValidator<MergePatch<{Model}>>` whose rules fire only when the corresponding property is present in the patch body. |
| `ValidatorsInitializer.g.cs` | Static `AddGeneratedValidators(this IServiceCollection)` extension method for DI setup.                                                  |

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

Properties marked `@visibility(Lifecycle.Read)` (read-only) generate rejection rules rather than validation rules. In PATCH validators over a `MergePatchUpdate<T>` body they emit a "must not be present" rule so clients cannot supply the field at all. In POST validators — and in PATCH validators over a plain body — nullable read-only properties emit a `Null()` rule; non-nullable read-only properties produce no rule (the field is simply ignored).

### PATCH body shapes

PATCH validators emit one of two rule shapes, chosen by the body type of the `@patch` operation.

**`MergePatchUpdate<T>` body.** The body is a `MergePatch<T>` container that captures raw JSON, so rules are keyed by property name and can tell "field absent" apart from "field explicitly null":

```csharp
this.RuleFor(x => x)
    .Must(x => decimal.TryParse(x.GetString("Target"), /* ... */, out decimal n) && n >= 0m)
    .When(x => x.IsDefined("Target") && !x.IsNull("Target"))
    .WithName("Target");
```

**Plain model body.** When the `@patch` operation takes an ordinary model instead, the body is a plain POCO with no `IsDefined`/`GetString`/`IsNull` members, so rules use typed property access guarded on null:

```csharp
RuleFor(x => x.Target).GreaterThanOrEqualTo(0).When(x => x.Target is not null);
```

A plain POCO cannot distinguish an omitted field from one explicitly set to `null`, so a `null` value is treated as "not supplied" and the rule is skipped. Required-ness therefore degrades to a non-null check. If you need true absent-vs-null semantics, use a `MergePatchUpdate<T>` body.

The null guard is emitted only when the property can actually hold `null`; a non-nullable value-type property (for example a required `int32` under `nullable-properties: false`) gets the rule with no `.When` clause.

Nested-model rules account for property nullability so the generated code compiles cleanly and doesn't hand a `null` instance to a child validator. When the nested property (or collection) is nullable:

- The property access uses the null-forgiving operator (`x.Prop!`) so the emitted `IValidator<T>` type argument matches, avoiding a nullable-reference-type build warning.
- The rule adds `.When(x => x.Prop is not null)` so it is skipped at runtime when the property is `null`. This applies to POST validators and to PATCH validators over a plain body.
- PATCH validators over a `MergePatchUpdate<T>` body emit no nested-model rules at all, because the container holds raw JSON rather than a typed child instance.

For discriminated hierarchies (`@discriminator("...")`), the discriminator property itself is excluded from generated validators for both base and derived models. This avoids invalid rules against a wire-level polymorphism marker and prevents false validation failures for discriminator values supplied by polymorphic serialization.

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

| Option                        | Default         | Description                                                      |
| ----------------------------- | --------------- | ---------------------------------------------------------------- |
| `emit-validators`             | `false`         | Enable validator generation.                                     |
| `validators`                  | `"both"`        | Which validator types to emit: `"post"`, `"patch"`, or `"both"`. |
| `validators-output-dir`       | `"Validators"`  | Output directory for validator and initializer files.            |
| `validators-root-namespace`   | _(global root)_ | Root namespace for validator files.                              |
| `validators-version-strategy` | _(auto)_        | Version strategy. Auto-detected from spec; see table above.      |

## Polymorphic dispatch

When a model carries `@discriminator`, the base-class POST validator automatically includes a `SetInheritanceValidator` block that dispatches to derived-type validators based on the runtime type. This ensures properties defined only on child models (e.g. `Cat.isPurrer`, `Dog.isBarker`) are validated even though the controller payload is typed as the base class.

```csharp
// Generated in PetValidator (base)
RuleFor(x => x).SetInheritanceValidator(v =>
{
    v.Add<MyApp.Models.Cat>(catValidator);
    v.Add<MyApp.Models.Dog>(dogValidator);
});
```

The derived-type validators are injected as `AbstractValidator<TDerived>` constructor parameters and resolved from DI via the registrations in `ValidatorsInitializer.g.cs`.

> **Note:** Polymorphic dispatch is emitted only for POST validators. MergePatch-based PATCH validators operate on a generic `MergePatch<T>` wrapper that is not polymorphic, so inheritance dispatch does not apply there.
