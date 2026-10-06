# Custom Templates

Each generated artifact is rendered from a Handlebars template. Any template can be replaced via the `templates` option in `tspconfig.yaml`:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    templates:
      class: ./templates/class.hbs
      enum-member-converter: ./templates/enum-member-converter.hbs
```

Templates are compiled with `noEscape: true` (so `<`, `>`, and `&` pass through unchanged). The built-in `indent` helper prefixes every non-empty line of its argument with four spaces.

## View models

| Template                | View model                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`                  | `{ namespace: string, usings: string[], body: string }` — `body` is the already-rendered inner block.                                                                                                                                                                                                                                                                                                                                       |
| `class`                 | `{ doc?: string, className: string, interfaceName?: string, baseClass?: string, bases: string, properties: Property[], propertiesBlock: string }` — `bases` is `baseClass` and `interfaceName` joined by `, `; `propertiesBlock` is the pre-rendered property list.                                                                                                                                                                         |
| `interface`             | `{ doc?: string, interfaceName: string, baseInterface?: string, baseClause: string, properties: Property[], propertiesBlock: string }` — `baseClause` is `" : <baseInterface>"` or `""`.                                                                                                                                                                                                                                                    |
| `enum`                  | `{ doc?: string, enumName: string, members: Member[], membersBlock: string }` — `membersBlock` is each member pre-rendered with trailing commas.                                                                                                                                                                                                                                                                                            |
| `controller`            | `{ doc?: string, controllerName: string, serviceName: string, serviceInterfaceName: string, routes: string[], operations: Operation[], actionsBlock: string }` — `routes` has one entry per API version.                                                                                                                                                                                                                                    |
| `service-interface`     | `{ doc?: string, interfaceName: string, serviceName: string, operations: Operation[], methodsBlock: string }`                                                                                                                                                                                                                                                                                                                               |
| `merge-patch`           | _(no variables — static `MergePatch<T>` generic helper class, used when `merge-patch-style` is `"generic"`)_                                                                                                                                                                                                                                                                                                                                |
| `entity-merge-patch`    | `{ modelName: string, qualifiedModelName: string }` — per-entity typed merge patch class, used when `merge-patch-style` is `"typed"`. `modelName` is the short C# class name (e.g. `"Widget"`); `qualifiedModelName` is how other files reference it: the short name by default, or fully qualified (e.g. `"Demo.Models.Widget"`) with `fully-qualified-types: true` or a [clashing name](models.md#names-that-clash-with-framework-types). |
| `enum-member-converter` | _(no variables — static helper class)_                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bool-string-converter` | _(no variables — static `BooleanStringJsonConverter` helper class, emitted when a property uses `@encode(string)` on a boolean)_                                                                                                                                                                                                                                                                                                            |

## Validator view models

The validator templates (`validator-post`, `validator-patch`, `validator-post-version-aware`, `validator-patch-version-aware`) receive:

| Variable                     | Description                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`                  | Validators namespace.                                                                                                                                                                  |
| `modelsNamespace`            | Models namespace. Emit `using {{{modelsNamespace}}};` unless `fullyQualifiedTypes` is set.                                                                                             |
| `helpersNamespace`           | Helpers namespace. Emit `using {{{helpersNamespace}}};` when `useHelpersNamespace` is set.                                                                                             |
| `fullyQualifiedTypes`        | The `fully-qualified-types` option.                                                                                                                                                    |
| `useHelpersNamespace`        | `true` when the body is the generic `MergePatch<T>` and type names are short.                                                                                                          |
| `modelName`                  | Short C# class name of the validated model (e.g. `"Pet"`).                                                                                                                             |
| `qualifiedModelName`         | How to reference the model: short by default, fully qualified with `fully-qualified-types: true` or a [clashing name](models.md#names-that-clash-with-framework-types).                |
| `validatorName`              | PATCH only. Validator class name: `{Model}PatchValidator`, or `{Model}MergePatchValidator` when the model needs [both PATCH validators](validators.md#one-model-two-patch-body-types). |
| `qualifiedPatchBodyTypeName` | PATCH only. Type argument of `AbstractValidator<T>` (e.g. `MergePatch<Pet>`).                                                                                                          |
| `isMergePatchBody`           | PATCH only. `true` for a `MergePatchUpdate<T>` body.                                                                                                                                   |
| `usesJsonOptions`            | PATCH only. `true` when the constructor takes `IOptions<Microsoft.AspNetCore.Mvc.JsonOptions> jsonOptions` and declares `jsonSerializerOptions` for nested rules.                      |
| `properties`                 | Property rules (version-aware templates use `baseProperties` and `versionGroups` instead).                                                                                             |
| `referencedValidators`       | Injected child validators: `{ qualifiedValidatorTypeName, paramName }`.                                                                                                                |
| `derivedTypeValidators`      | POST only. Derived-type validators for polymorphic dispatch.                                                                                                                           |

The `mergePatchNestedRules` partial renders the rule for a model-typed property of a MergePatch body. Include it from a custom PATCH template inside `{{#each properties}}` with `{{> mergePatchNestedRules}}` on its own line; every rendered line gets that line's indent.

### Upgrading custom templates

Generated references are short names by default, so a custom template copied from an older release must import the namespaces it references. Add these lines after `using FluentValidation;` (as the built-in templates do), or set `fully-qualified-types: true`:

```handlebars
{{#unless fullyQualifiedTypes}}
  using
  {{{modelsNamespace}}};
  {{#if useHelpersNamespace}}
    using
    {{{helpersNamespace}}};
  {{/if}}
{{/unless}}
```

Custom PATCH templates should also use `{{{validatorName}}}` instead of `{{{modelName}}}PatchValidator`, and add the `jsonOptions` constructor parameter when `usesJsonOptions` is set.

## Shared sub-types

- `Property` — `{ doc?: string, type: string, name: string, attributes?: string[] }` — `attributes` are extra serialization attributes (complete `[...]` strings) from `@encode`, emitted after `[JsonPropertyName]`.
- `Member` — `{ doc?: string, name: string, memberValue: string, value?: number }`
- `Operation` — `{ doc?: string, name: string, httpVerb: string, routeSuffix?: string, params: Param[], returnType: string }`
- `Param` — `{ name: string, type: string, binding: string, optional: boolean }`

`doc`, when present, is a fully formatted XML doc-comment block — emit it verbatim above the declaration.

## Available template keys

| Key                             | Overrides                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `file`                          | Namespace + using wrapper for every generated file.                                      |
| `class`                         | C# class declarations.                                                                   |
| `interface`                     | C# interface declarations.                                                               |
| `enum`                          | C# enum declarations.                                                                    |
| `controller`                    | ASP.NET Core abstract controller base classes.                                           |
| `service-interface`             | Service interface declarations.                                                          |
| `merge-patch`                   | `MergePatch<T>` generic helper class (used when `merge-patch-style` is `"generic"`).     |
| `entity-merge-patch`            | Per-entity `{Model}MergePatchUpdate` class (used when `merge-patch-style` is `"typed"`). |
| `enum-member-converter`         | `EnumMemberConverterFactory` and `EnumMemberConverter<T>` helper classes.                |
| `bool-string-converter`         | `BooleanStringJsonConverter` helper class (for `@encode(string)` on booleans).           |
| `validator-post`                | Standard POST validator (`AbstractValidator<{Model}>`).                                  |
| `validator-patch`               | Standard PATCH validator with conditional patch-aware rules.                             |
| `validator-post-version-aware`  | Version-aware POST validator with `When(() => IsAtLeast(...))` guards.                   |
| `validator-patch-version-aware` | Version-aware PATCH validator with `When(() => IsAtLeast(...))` guards.                  |
| `validator-initializer`         | `ValidatorsInitializer` DI registration class.                                           |
