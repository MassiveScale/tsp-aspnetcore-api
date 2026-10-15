# Custom Templates

Each generated artifact is rendered from a Handlebars template. Any template can be replaced via the `templates` option in `tspconfig.yaml`:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    templates:
      class: ./templates/class.hbs
      enum-member-converter: ./templates/enum-member-converter.hbs
```

All templates except the validator templates are compiled with `noEscape: true`, so `<`, `>`, and `&` pass through unchanged. The validator templates (`validator-post`, `validator-patch`, `validator-post-version-aware`, `validator-patch-version-aware`, `validator-initializer`) use Handlebars' default HTML escaping: use triple braces (`{{{qualifiedModelName}}}`) for any value that can contain `<` or `>`, such as `MergePatch<Pet>`. Validator templates also render the complete file, so they are not wrapped by the `file` template.

Template files are read with LF line endings whatever the checkout uses, and three helpers are available:

- `indent` prefixes every non-empty line of its argument with four spaces.
- `isDefined` returns `true` when its argument is not `undefined`, e.g. `{{#if (isDefined value)}} = {{value}}{{/if}}`.
- `eq` returns `true` when its two arguments are strictly equal, e.g. `{{#if (eq returnType "void")}}`.

## View models

| Template                | View model                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`                  | `{ fileName: string, namespace: string, usings: string[], body: string }` — `fileName` is the emitted file name (e.g. `"Widget.g.cs"`); `body` is the already-rendered inner block.                                                                                                                                                                                                                                                         |
| `class`                 | `{ doc?: string, className: string, isAbstract?: boolean, interfaceName?: string, baseClass?: string, bases: string, properties: Property[], propertiesBlock: string, discriminator?: Discriminator, patchMethodBlock?: string }` — `bases` is `baseClass` and `interfaceName` joined by `, `; `propertiesBlock` is the pre-rendered property list.                                                                                         |
| `interface`             | `{ doc?: string, interfaceName: string, baseInterface?: string, baseClause: string, properties: Property[], propertiesBlock: string }` — `baseClause` is `" : <baseInterface>"` or `""`.                                                                                                                                                                                                                                                    |
| `enum`                  | `{ doc?: string, enumName: string, members: Member[], membersBlock: string }` — `membersBlock` is each member pre-rendered with trailing commas.                                                                                                                                                                                                                                                                                            |
| `controller`            | `{ doc?: string, controllerName: string, serviceName: string, serviceInterfaceName: string, operations: Operation[], actionsBlock: string }` — `actionsBlock` is every action pre-rendered. Routes live on each operation, not on the controller.                                                                                                                                                                                           |
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

<!-- prettier-ignore -->
```handlebars
{{#unless fullyQualifiedTypes}}
using {{{modelsNamespace}}};
{{#if useHelpersNamespace}}
using {{{helpersNamespace}}};
{{/if}}
{{/unless}}
```

Custom PATCH templates should also use `{{{validatorName}}}` instead of `{{{modelName}}}PatchValidator`, and add the `jsonOptions` constructor parameter when `usesJsonOptions` is set.

## Shared sub-types

- `Property` — `{ doc?: string, type: string, name: string, jsonName: string, nullable: boolean, attributes?: string[], initializer?: string }` — `attributes` are extra serialization attributes (complete `[...]` strings) from `@encode`, emitted after `[JsonPropertyName]`; `initializer` is the C# default-value expression, when the property has one.
- `Member` — `{ doc?: string, name: string, memberValue: string, value?: number }`
- `Operation` — `{ doc?: string, name: string, httpVerb: string, routes: string[], routeSuffix?: string, params: Param[], cancellationToken: boolean, returnType: string }` — `routes` has one absolute route per API version in which the operation is available; `routeSuffix` is the operation's own `@route` segment, for information only.
- `Param` — `{ name: string, type: string, binding: string, optional: boolean, bindingName?: string }` — `bindingName` is the HTTP wire name when `@serverName` renamed the C# identifier.
- `Discriminator` — `{ propertyName: string, derivedTypes: { className: string, discriminatorValue: string }[] }`

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
