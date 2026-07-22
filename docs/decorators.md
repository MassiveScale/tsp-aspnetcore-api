# Decorators

Import the package in your TypeSpec file to use these decorators:

```typespec
import "@massivescale/tsp-aspnetcore-api";
using MassiveScale.AspNetCoreApi;
```

## `@serverName`

Overrides the C# identifier for a model or model property. For models it also changes the generated file name and all generated references to that model (including controller/service signatures). The value must be a valid C# identifier. Bare reserved keywords (e.g. `class`, `string`) are rejected; prefix with `@` to form a verbatim identifier (e.g. `@class`).

```typespec
@serverName(name: valueof string)
```

| Target           | What changes                                       | What stays the same                   |
| ---------------- | -------------------------------------------------- | ------------------------------------- |
| `model`          | Class name, interface name (`I<Name>`), file names | `JsonPropertyName` values             |
| `model property` | C# property identifier                             | `[JsonPropertyName("...")]` wire name |

```typespec
@serverName("PetRequest")
model Pet {
  @serverName("Identifier")
  id: string;
  name: string;
}

enum Status {
  active: "active";
}
```

Produces `PetRequest.g.cs` / `IPetRequest.g.cs` with a property named `Identifier` (still `[JsonPropertyName("id")]`).

When a model server name starts with `@` (for a C# verbatim identifier), the class file keeps the `@` prefix (for example `@class.g.cs`) while the interface file and type use `I` plus the identifier without `@` (for example `Iclass.g.cs`, `interface Iclass`).
