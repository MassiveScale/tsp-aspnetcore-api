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

| Template                | View model                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`                  | `{ namespace: string, usings: string[], body: string }` — `body` is the already-rendered inner block.                                                                                                                                                              |
| `class`                 | `{ doc?: string, className: string, interfaceName: string, baseClass?: string, bases: string, properties: Property[], propertiesBlock: string }` — `bases` is `baseClass` and `interfaceName` joined by `, `; `propertiesBlock` is the pre-rendered property list. |
| `interface`             | `{ doc?: string, interfaceName: string, baseInterface?: string, baseClause: string, properties: Property[], propertiesBlock: string }` — `baseClause` is `" : <baseInterface>"` or `""`.                                                                           |
| `enum`                  | `{ doc?: string, enumName: string, members: Member[], membersBlock: string }` — `membersBlock` is each member pre-rendered with trailing commas.                                                                                                                   |
| `controller`            | `{ doc?: string, controllerName: string, serviceName: string, serviceInterfaceName: string, routes: string[], operations: Operation[], actionsBlock: string }` — `routes` has one entry per API version.                                                           |
| `service-interface`     | `{ doc?: string, interfaceName: string, serviceName: string, operations: Operation[], methodsBlock: string }`                                                                                                                                                      |
| `service-class`         | `{ doc?: string, serviceName: string, interfaceName: string, operations: Operation[], methodsBlock: string }`                                                                                                                                                      |
| `merge-patch-value`     | _(no variables — static helper class)_                                                                                                                                                                                                                             |
| `enum-member-converter` | _(no variables — static helper class)_                                                                                                                                                                                                                             |

## Shared sub-types

- `Property` — `{ doc?: string, type: string, name: string }`
- `Member` — `{ doc?: string, name: string, memberValue: string, value?: number }`
- `Operation` — `{ doc?: string, name: string, httpVerb: string, routeSuffix?: string, params: Param[], returnType: string }`
- `Param` — `{ name: string, type: string, binding: string, optional: boolean }`

`doc`, when present, is a fully formatted XML doc-comment block — emit it verbatim above the declaration.

## Available template keys

| Key                     | Overrides                                               |
| ----------------------- | ------------------------------------------------------- |
| `file`                  | Namespace + using wrapper for every generated file.     |
| `class`                 | C# class declarations.                                  |
| `interface`             | C# interface declarations.                              |
| `enum`                  | C# enum declarations.                                   |
| `controller`            | ASP.NET Core abstract controller base classes.          |
| `service-interface`     | Service interface declarations.                         |
| `merge-patch-value`     | `MergePatchValue<T>` helper class.                      |
| `enum-member-converter` | `EnumMemberConverterFactory` and `EnumMemberConverter<T>` helper classes. |
