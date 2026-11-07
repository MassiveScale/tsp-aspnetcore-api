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

## `@patchStrategy`

Sets what a JSON Merge Patch (`MergePatchUpdate<T>`) body does with an object sent for a property that holds a single model. It overrides the `merge-patch-nested-models` emitter option, which defaults to `"merge"`.

```typespec
@patchStrategy(strategy: valueof "merge" | "replace")
```

| Strategy    | Applying the patch                                                                | PATCH validation                                                   |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `"merge"`   | RFC 7396: only the members the object sends change. The others keep their values. | The object is a partial patch, checked by `{Model}PatchValidator`. |
| `"replace"` | The object replaces the current value. Members it leaves out are cleared.         | The object is a complete model, checked by `{Model}Validator`.     |

```typespec
model QuotaGroup {
  displayName: string;

  // A client always sends the whole targeting, and the server stores it as sent.
  @patchStrategy("replace")
  targeting: Targeting;
}
```

A replaced property gets `[JsonObjectCreationHandling(JsonObjectCreationHandling.Replace)]` in the generated model. The generated MergePatch helpers read that attribute when they apply a patch, so a hand-written model can opt in the same way. For ordinary deserialization the attribute is the default behavior, so it changes nothing else.

The decorator only applies to a property that holds a single model, optionally nullable. On anything else it has no effect and the compiler warns (`patch-strategy-ignored`): an array is always replaced, and a record is always merged key by key. See [RFC 7396 Merge Patch — Replacing a nested model](merge-patch.md#replacing-a-nested-model).
