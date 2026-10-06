# FluentValidation Validators

When `emit-validators: true`, the emitter generates [FluentValidation](https://docs.fluentvalidation.net/) validator classes for models that appear as POST or PATCH request bodies, plus a `ValidatorsInitializer.g.cs` helper to register them with ASP.NET Core's DI container.

## Generated files

| File                              | Content                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{Model}Validator.g.cs`           | `AbstractValidator<{Model}>` with rules for POST bodies.                                                                                                    |
| `{Model}PatchValidator.g.cs`      | Patch-aware `AbstractValidator<MergePatch<{Model}>>` whose rules fire only when the corresponding property is present in the patch body.                    |
| `{Model}MergePatchValidator.g.cs` | Only when a model is validated both as a plain PATCH body and as a MergePatch body. See [One model, two PATCH body types](#one-model-two-patch-body-types). |
| `ValidatorsInitializer.g.cs`      | Static `AddGeneratedValidators(this IServiceCollection)` extension method for DI setup.                                                                     |

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

| TypeSpec decorator                                                                             | FluentValidation rule                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Required non-optional `string`                                                                 | `NotEmpty()`                                     |
| Required non-optional property of any other type (number, `boolean`, date, enum, model, array) | `NotNull()` (POST)                               |
| `@minLength(n)`                                                                                | `MinimumLength(n)`                               |
| `@maxLength(n)`                                                                                | `MaximumLength(n)`                               |
| `@pattern("...")`                                                                              | `Matches(@"...")`                                |
| `@format("email")`                                                                             | `EmailAddress()`                                 |
| `@minValue(n)`                                                                                 | `GreaterThanOrEqualTo(n)`                        |
| `@maxValue(n)`                                                                                 | `LessThanOrEqualTo(n)`                           |
| Enum property                                                                                  | `IsInEnum()`                                     |
| Nested model property                                                                          | `SetValidator(childValidator)` (injected via DI) |

A property is **required** when it is not optional (`?`) and has no default value. Required rules apply to every type, not just strings. If the declared type explicitly allows `null` (`note: string | null`, `count: int32 | null`), the property must be present, but `null` is a valid value, so it gets no `NotNull()` or reject-null rule.

| Validator                     | Required string                                                                                                     | Required non-string                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| POST                          | `NotEmpty()`                                                                                                        | `NotNull()`                                     |
| PATCH (`MergePatchUpdate<T>`) | May be omitted. An explicit `null` is rejected ("is required and cannot be null"), and an empty string is rejected. | May be omitted. An explicit `null` is rejected. |
| PATCH (plain body)            | `NotEmpty()` when supplied                                                                                          | No rule (`null` means "not supplied")           |

`NotNull()` is only emitted when the C# property can hold `null`. That's always true with the default `nullable-properties: true`. With `nullable-properties: false`, a required value type (`int`, `bool`, `DateTimeOffset`, …) is non-nullable, and an absent field reads as `0` / `false`, so no rule can tell it apart. Reference types (models, arrays, `Uri`) are still checked.

### Read-only and lifecycle-restricted properties

A property that is not writable for the operation's lifecycle phase gets a **rejection** rule instead of validation rules:

| Visibility                                                    | POST (Create)                            | PATCH (Update)                               |
| ------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `@visibility(Lifecycle.Read)` (read-only)                     | Rejected: "is read-only"                 | Rejected: "is read-only"                     |
| `@visibility(Lifecycle.Create, Lifecycle.Read)` (immutable)   | Validated normally                       | Rejected: "cannot be changed after creation" |
| `@visibility(Lifecycle.Update, Lifecycle.Read)` (update-only) | Rejected: "can only be set by an update" | Validated normally                           |

In PATCH validators over a `MergePatchUpdate<T>` body, a rejected property gets a "must not be present" rule, so clients can't supply the field at all. In POST validators, and in PATCH validators over a plain body, a nullable rejected property gets a `Null()` rule. A non-nullable one gets no rule, because it can't be told apart from "not supplied", so the field is simply ignored. This applies to properties of every type.

Rejection rules are emitted for every API version, including versions where the property doesn't exist yet. With the `earliest` and `per-version` strategies, an update-only property `@added` in v2 is still rejected by the v1 POST validator. TypeSpec can't change a property's visibility between versions, so there's no version in which that property is writable in that phase. The single model class declares it, so the rule compiles, and an older-version client can't slip the value through.

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

A plain POCO cannot distinguish an omitted field from one explicitly set to `null`, so a `null` value is treated as "not supplied" and the rule is skipped. Required-ness therefore can't be enforced on a plain PATCH body. If you need true absent-vs-null semantics, use a `MergePatchUpdate<T>` body.

The null guard is emitted only when the property can actually hold `null`; a non-nullable value-type property (for example a required `int32` under `nullable-properties: false`) gets the rule with no `.When` clause.

Nested-model rules account for property nullability so the generated code compiles cleanly and doesn't hand a `null` instance to a child validator. When the nested property (or collection) is nullable:

- The property access uses the null-forgiving operator (`x.Prop!`) so the emitted `IValidator<T>` type argument matches, avoiding a nullable-reference-type build warning.
- The rule adds `.When(x => x.Prop is not null)` so it is skipped at runtime when the property is `null`. This applies to POST validators and to PATCH validators over a plain body.
- PATCH validators over a `MergePatchUpdate<T>` body inspect the raw JSON value. A supplied nested object is passed to its injected child PATCH validator, and child failures are prefixed with the parent path (for example, `Appearance.Theme`). Non-object values are rejected at the parent property. Nested validators recurse to further model levels and keep their own constraints, required-null checks, enum checks, and read-only/create-only rules.
- A model array in a MergePatch body is a whole-value replacement under RFC 7396. Every supplied element must be an object and is validated as a complete model using its injected POST validator; failures use paths such as `Items[0].Name`. Arrays are not interpreted as collections of partial item patches. An element that can't be deserialized, for example an item of an abstract `@discriminator` base type sent without its discriminator, fails validation with "The array item could not be deserialized." instead of throwing.

Nested-only validators are emitted and registered when reachable through a PATCH body's model properties, including properties that only a derived model declares. Derived models of a nested `@discriminator` base get POST validators too, because the base validator injects them. Constructor injection is used throughout. Arbitrarily deep acyclic model shapes are supported.

#### JSON options

A MergePatch validator that validates nested values reads them with the application's JSON settings, so it accepts the same payloads as model binding (case-insensitive property names, numbers sent as strings, custom converters). Its constructor takes `IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>`, which `AddControllers()` registers, and passes `JsonSerializerOptions` to every nested deserialization. Configure it the usual way:

```csharp
builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(new MyConverter()));
```

Validators without nested model properties keep their existing constructor.

#### Recursive models

Recursive nested MergePatch validation is not supported. When a writable object property leads back to a model already on the path (`model Node { child?: Node; }`, or `A → B → A`), the emitter reports a **`merge-patch-recursive-reference`** error on the property that closes the loop: the generated validators would need each other in their constructors and could not be resolved from dependency injection. Break the loop by excluding the property from updates (for example `@visibility(Lifecycle.Read, Lifecycle.Create)`), or emit only POST validators with `validators: "post"`. Arrays (`children?: Node[]`) don't form a loop, because array items are validated by POST validators.

#### One model, two PATCH body types

A model can be validated as a plain PATCH body (its own `@patch` route takes the model directly) and as a MergePatch body (it is nested inside another route's `MergePatchUpdate<T>`). Both validators are emitted and registered:

| Validator                    | Validates             |
| ---------------------------- | --------------------- |
| `{Model}PatchValidator`      | `{Model}`             |
| `{Model}MergePatchValidator` | `MergePatch<{Model}>` |

When a model only needs one of them, it is always called `{Model}PatchValidator`.

Version-aware child patch validators retain their `IsAtLeast` guards. Therefore, a nested member introduced in a later version is validated only when that version is active, just like a top-level member.

For discriminated hierarchies (`@discriminator("...")`), the discriminator property itself is excluded from generated validators for both base and derived models. This avoids invalid rules against a wire-level polymorphism marker and prevents false validation failures for discriminator values supplied by polymorphic serialization.

## Custom rules

Every generated validator is a `partial class` that declares a [partial method](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/partial-member) named `ExtendRules()` and calls it at the end of its constructor. Implement it in a hand-written partial (same class name and namespace) to add custom rules without editing the generated file:

```csharp
using FluentValidation;

namespace Demo.Validators;

public partial class WidgetValidator
{
    partial void ExtendRules()
    {
        RuleFor(x => x.Name).Must(name => !name.Contains("admin")).WithMessage("Name cannot contain 'admin'.");
    }
}
```

Write it exactly as `partial void ExtendRules()`, with no access modifier. Do not use `override`: C# does not allow one part of a partial class to override a member declared in another part of the same class, so `protected override void ExtendRules()` fails with CS0111 (duplicate member) and CS0115 (no method to override). Your file needs `using FluentValidation;` for the `RuleFor` extension methods, because `using` directives in the generated part don't carry over. Implementing it is optional. If no hand-written part implements it, the compiler removes both the declaration and the call.

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
