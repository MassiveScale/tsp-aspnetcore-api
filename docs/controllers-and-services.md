# Controllers and Services

When the TypeSpec source includes `@typespec/http` operations, the emitter produces ASP.NET Core controllers and matching service interfaces.

For each HTTP `interface` (or `namespace`) that carries routes, the emitter writes:

| File                      | Content                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Name>ControllerBase.cs` | Abstract ASP.NET Core controller inheriting `ControllerBase`. Injects `I<Name>Service` and delegates every action to the service.                               |
| `I<Name>Service.cs`       | Partial service interface with one `Task<T>` method per operation. The `partial` keyword enables extending the interface with custom methods in consuming code. |

**Routes** — one `[Http<Verb>("...")]` attribute is emitted per available API version of each operation. Without versioning a single attribute is emitted using the resolved operation path.

**Parameter binding** — path parameters get `[FromRoute]`, query parameters get `[FromQuery]`, headers get `[FromHeader]`, and request bodies get `[FromBody]`. When [`@serverName`](./decorators.md) renames a parameter's emitted C# identifier, the binding attribute gets an explicit `Name = "..."` pointing at the original wire name (e.g. `[FromQuery(Name = "custId")] string customerId`), so the HTTP contract is unaffected by the rename.

## Return types and response models

The service method's return type comes from the first non-`@error` 2xx response **body**, as resolved by `@typespec/http`. It is never the response model itself. (A _response model_ describes the HTTP response: status code, headers and body. See [Which models get a class](./models.md#which-models-get-a-class).)

| Response declared as                                                       | Service return type                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Widget`                                                                   | `Task<Widget?>`                                                                                                              |
| `model EntityResponse<T> { ...OkResponse; ...ETagHeader; @body body: T; }` | `Task<Widget?>` for `EntityResponse<Widget>`. The `@body` type is returned, and no `EntityResponse` class is emitted.        |
| `model R { @statusCode code: 201; @bodyRoot widget: Widget; }`             | `Task<Widget?>`                                                                                                              |
| `model UpdatedResponse { ...NoContentResponse; ...ETagHeader; }`           | `Task` (a _metadata-only model_ has no body)                                                                                 |
| `model R { @header("ETag") etag: string; name: string; }`                  | `Task<R?>`. This is an _implicit body_: class `R` is emitted with only `Name`, so the return type matches the emitted class. |
| `PagedResult<Widget>` (a template instance used directly)                  | `Task<PagedResultWidget?>`                                                                                                   |

`@error` responses never become the return type. That covers an `@error` body, and also an `@error` envelope that declares a 2xx status with a non-error body (`@error model OddError { @statusCode code: 200; @body body: Problem; }`).

Response headers and status codes are not part of the return type. Set them in your controller implementation, e.g. `Response.Headers.ETag = ...`.

Spread parameter models such as `...IfMatchHeader`, or models of `@path` / `@query` parameters, are flattened into individual action and service parameters. They don't produce a class:

```typespec
model IfMatchHeader { @header("If-Match") ifMatch?: string; }

@patch update(...IfMatchHeader, @body body: Widget): UpdatedResponse;
```

```csharp
public abstract Task<IActionResult> Update([FromHeader(Name = "If-Match")] string? ifMatch, [FromBody] Widget body, CancellationToken cancellationToken);
```

An implicit _request_ body (plain parameters next to metadata, e.g. `create(@header h: string, name: string)`) has no named model. It is still bound as `[FromBody] object body`.

## Example

```typespec
import "@typespec/http";
import "@typespec/versioning";
using TypeSpec.Http;
using TypeSpec.Versioning;

@service
@versioned(Versions)
namespace MyApi;

enum Versions { v1, v2 }

model User { id: string; name: string; }

@route("/users")
interface Users {
  @get list(): User[];
  @get @route("{id}") read(@path id: string): User;
  @post create(@body user: User): User;
}
```

With `route-prefix: api` the above produces:

```csharp
// Controllers/UsersControllerBase.cs
[Route("/api/v1/users")]
[Route("/api/v2/users")]
[ApiController]
public abstract class UsersControllerBase : ControllerBase
{
    private readonly IUsersService _service;

    public UsersControllerBase(IUsersService service) { _service = service; }

    [HttpGet]
    public async Task<IActionResult> List() => Ok(await _service.List());

    [HttpGet("{id}")]
    public async Task<IActionResult> Read([FromRoute] string id) => Ok(await _service.Read(id));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] User body) => Ok(await _service.Create(body));
}
```

```csharp
// Services/IUsersService.cs
public partial interface IUsersService
{
    Task<IList<User>> List();
    Task<User> Read(string id);
    Task<User> Create(User body);
}
```

## Disabling output

Controllers and service interfaces can be disabled independently:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    emit-controllers: false # skip controller files
    emit-services: false # skip service interface files
```

## Related options

| Option                       | Default         | Description                                                                                                                                 |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `abstract-suffix`            | `"Base"`        | Suffix appended to generated abstract class names, e.g. `UsersControllerBase`.                                                              |
| `cancellation-token`         | `true`          | When `true`, adds `CancellationToken cancellationToken` to every controller action and service method, and emits `using System.Threading;`. |
| `controllers-output-dir`     | `"Controllers"` | Destination for generated controller files.                                                                                                 |
| `controllers-root-namespace` | _(global root)_ | Root namespace for controller files.                                                                                                        |
| `route-prefix`               | `"api"`         | Prefix prepended to every controller route, e.g. `"api"` → `/api/v1/users`.                                                                 |
| `services-output-dir`        | `"Services"`    | Destination for generated service interface files.                                                                                          |
| `services-root-namespace`    | _(global root)_ | Root namespace for service interface files.                                                                                                 |
