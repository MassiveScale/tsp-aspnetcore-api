# Namespace Resolution

The emitter uses different strategies for models/interfaces/enums versus controllers/services/helpers.

## Models, interfaces, and enums

The C# namespace is always derived from the TypeSpec namespace (after applying `namespace-map`).

When `namespace-from-path` is `true` (the default) **and** an output-dir is configured, the output-dir path segments are PascalCased and **appended** to the TypeSpec namespace. Files are placed flat in the output directory.

| Configuration                                                                    | TypeSpec namespace | C# namespace       | File path                |
| -------------------------------------------------------------------------------- | ------------------ | ------------------ | ------------------------ |
| `root-namespace: App`                                                            | `App.Users`        | `App.Users`        | `Users/User.g.cs`        |
| `root-namespace: App`, `models-output-dir: models`                               | `App.Users`        | `App.Users.Models` | `models/User.g.cs`       |
| `root-namespace: App`, `models-output-dir: models`, `namespace-from-path: false` | `App.Users`        | `App.Users`        | `models/Users/User.g.cs` |

When a model's namespace does not start with `root-namespace`, the file is placed flat at the output root while keeping its TypeSpec namespace unchanged.

## Controllers, services, and helpers

The C# namespace is always path-derived: `rootNs` + PascalCased output-dir segments, where `rootNs` is the section-specific root (`controllers-root-namespace`, `services-root-namespace`, etc.) when set, otherwise the explicit `root-namespace`, otherwise the namespace inferred from the TypeSpec namespace tree.

| `root-namespace` | `controllers-root-namespace` | `controllers-output-dir` | C# namespace                     |
| ---------------- | ---------------------------- | ------------------------ | -------------------------------- |
| `MyApp`          | _(not set)_                  | `Controllers` (default)  | `MyApp.Controllers`              |
| `MyApp`          | `MyCompany.Platform`         | `Controllers` (default)  | `MyCompany.Platform.Controllers` |
| `MyApp`          | _(not set)_                  | `src/api`                | `MyApp.Src.Api`                  |
| _(omitted, TypeSpec ns = `Demo`)_ | _(not set)_   | `Controllers` (default)  | `Demo.Controllers`               |

When `namespace-from-path` is `false`, controllers and services use the TypeSpec namespace of their operation container instead.

## Per-section root namespace overrides

The `*-root-namespace` options (`controllers-root-namespace`, `services-root-namespace`, `validators-root-namespace`, `models-root-namespace`, `interfaces-root-namespace`) let you place each output type under a different root without changing `root-namespace` globally. Each option falls back to `root-namespace` when unset.

This is useful when the generated code lives in a separate assembly from the consuming project:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    root-namespace: MyApp
    controllers-root-namespace: MyApp.Web
    validators-root-namespace: MyApp.Infrastructure
```
