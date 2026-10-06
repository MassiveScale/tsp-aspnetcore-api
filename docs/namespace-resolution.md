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

## Cross-section references

Each section has its own namespace, so a file that references a type from another section needs either a `using` directive or a qualified name. By default (`fully-qualified-types: false`) generated files import the models and helpers namespaces they need and use short names, e.g. `Acme.Controllers` action signatures reference `Widget` alongside `using Acme.Models;`. Set `fully-qualified-types: true` to write `Acme.Models.Widget` instead and rely on no imports.

Model and enum names that clash with a framework type imported by generated files (`Task`, `Version`, `File`, …) are always qualified, whatever the setting. See [Cross-namespace references](models.md#cross-namespace-references) for the full list of reference sites and the name-clash rule.
