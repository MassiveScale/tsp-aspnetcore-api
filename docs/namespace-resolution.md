# Namespace Resolution

The emitter uses flat per-section namespaces. All models share one namespace, all controllers share one namespace, and so on. Per-section namespace options set the namespace verbatim — no directory segments are appended.

## Flat namespace model

Each output section has a dedicated namespace option:

| Section      | Option                  | Default                        |
| ------------ | ----------------------- | ------------------------------ |
| Models/Enums | `models-namespace`      | `<root-namespace>.Models`      |
| Interfaces   | _(always models ns)_    | same as models                 |
| Controllers  | `controllers-namespace` | `<root-namespace>.Controllers` |
| Services     | `services-namespace`    | `<root-namespace>.Services`    |
| Validators   | `validators-namespace`  | `<root-namespace>.Validators`  |
| Helpers      | `helpers-namespace`     | `<root-namespace>.Helpers`     |

When the option is set it is used **verbatim** — no `.Models` or other suffix is appended. When unset, the namespace defaults to the effective root namespace with the section name appended.

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    root-namespace: MyApp
    models-namespace: MyApp.Domain # verbatim — all models use "namespace MyApp.Domain"
    controllers-namespace: MyApp.Web # all controllers use "namespace MyApp.Web"
```

## File placement

`namespace-from-path` controls **file placement only** — it never affects the C# namespace written into the file.

| `namespace-from-path` | Placement                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `false` (default)     | Files go in subdirectories derived from the TypeSpec namespace (with `namespace-map` applied), with the root namespace prefix stripped. |
| `true`                | Files go flat directly inside their output directory (no subdirectories).                                                               |

### Examples with `root-namespace: App`

| TypeSpec namespace | `namespace-from-path` | File path                | C# namespace |
| ------------------ | --------------------- | ------------------------ | ------------ |
| `App.Users`        | `false` (default)     | `Models/Users/User.g.cs` | `App.Models` |
| `App.Users`        | `true`                | `Models/User.g.cs`       | `App.Models` |
| `Other.Stuff`      | `false`               | `Models/Foreign.g.cs`    | `App.Models` |

When a TypeSpec namespace does not start with the root namespace prefix, the file is placed at the root of its output directory.

## `namespace-map` and file placement

The `namespace-map` option rewrites TypeSpec namespace names before they are used for **folder path computation**. It does not affect the verbatim C# namespace written to the file.

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    root-namespace: Acme
    namespace-map:
      "Legacy.Common": "Acme.Common" # folder: Models/Common/  (namespace still Acme.Models)
```

With `namespace-from-path: false` and a matching root namespace, models in `Legacy.Common` are placed under `Models/Common/` because their TypeSpec namespace is mapped to `Acme.Common` before the `Acme` prefix is stripped.

## Fully-qualified cross-references

Because each section can have its own namespace, generated code never relies on `using` directives to reference types from another section (or another model in the same section) — every reference is written as a fully-qualified name, e.g. `Acme.Controllers` action signatures reference `Acme.Models.Widget`, not a bare `Widget` paired with `using Acme.Models;`. See [Cross-namespace references](models.md#cross-namespace-references) for the full list of reference sites this covers.
