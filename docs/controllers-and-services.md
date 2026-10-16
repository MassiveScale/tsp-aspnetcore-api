# Controllers and Services

When the TypeSpec source includes `@typespec/http` operations, the emitter produces ASP.NET Core controllers and matching service interfaces.

For each HTTP `interface` (or `namespace`) that carries routes, the emitter writes:

| File                        | Content                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Name>ControllerBase.g.cs` | Abstract ASP.NET Core controller inheriting `ControllerBase`, with one `public abstract Task<IActionResult>` action per operation. It has no constructor and no dependencies. |
| `I<Name>Service.g.cs`       | Partial service interface with one `<Operation>Async` method per operation. The `partial` keyword lets you add your own methods in consuming code.                            |

The generated controller only declares the HTTP surface. You write a concrete controller that derives from it, takes whatever dependencies it needs (usually the matching `I<Name>Service`), and implements each action. The example below shows one.

**Routes** — every action carries its own absolute route; there is no class-level `[Route]` attribute. One `[Http<Verb>("...")]` attribute is emitted per API version in which the operation is available, with `{version}` in `route-prefix` replaced by that version's value. Without `@versioned`, a single attribute is emitted and the `{version}` segment is removed.

**Parameter binding** — path parameters get `[FromRoute]`, query parameters get `[FromQuery]` (only the required ones by default, controlled by [`controller-query-params`](#query-parameters)), headers get `[FromHeader]`, and request bodies get `[FromBody]`. When a parameter's C# identifier differs from its wire name, the binding attribute gets an explicit `Name = "..."` pointing at the wire name (e.g. `[FromQuery(Name = "custId")] string customerId`), so the HTTP contract is unaffected.

**Parameter names** — the C# identifier is the [`@serverName`](./decorators.md) when one is set. Otherwise it is the camelCased wire name, made valid and unique within the action:

| Wire parameter                   | C# parameter                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `class` (a C# keyword)           | `[FromRoute] string @class`                                         |
| `x-request-id` header            | `[FromHeader(Name = "x-request-id")] string xRequestId`             |
| `2fa`                            | `[FromQuery(Name = "2fa")] string _2fa`                             |
| `user_id` and `userId` together  | `userId` and `userId2`                                              |
| `body` query with a request body | `[FromQuery(Name = "body")] string body2`                           |
| `cancellationToken` query        | `[FromQuery(Name = "cancellationToken")] string cancellationToken2` |

`body` and `cancellationToken` are reserved for the request body and the trailing `CancellationToken`.

**HTTP library warnings** — controllers and services are skipped only when `@typespec/http` reports an **error**. Warnings such as `merge-patch-content-type` or `response-cookie-not-supported` are reported as usual and every controller is still generated.

## Query parameters

The `controller-query-params` option decides which `@query` parameters appear in the controller action and the matching service method. The controller and the service always get the same parameters.

| Value                  | Query parameters emitted   |
| ---------------------- | -------------------------- |
| `"required"` (default) | Only the non-optional ones |
| `"all"`                | Every query parameter      |
| `"none"`               | None                       |

Path and header parameters and the request body are always emitted, whatever the value.

```typespec
@get search(@query q: string, @query page?: int32): Result[];
```

| Value        | Generated action                                                                           |
| ------------ | ------------------------------------------------------------------------------------------ |
| `"required"` | `Search([FromQuery] string q, CancellationToken cancellationToken)`                        |
| `"all"`      | `Search([FromQuery] string q, [FromQuery] int? page, CancellationToken cancellationToken)` |
| `"none"`     | `Search(CancellationToken cancellationToken)`                                              |

A query parameter that is left out is still part of the HTTP contract. Read it in your controller implementation, for example with `Request.Query["page"]`, and pass it to the service yourself.

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

With the default `route-prefix` (`"api/{version}"`) the above produces the following (file headers and `using` directives omitted):

```csharp
// Controllers/UsersControllerBase.g.cs
namespace MyApi.Controllers
{
    [ApiController]
    public abstract class UsersControllerBase : ControllerBase
    {
        [HttpGet("/api/v1/users")]
        [HttpGet("/api/v2/users")]
        public abstract Task<IActionResult> List(CancellationToken cancellationToken);

        [HttpGet("/api/v1/users/{id}")]
        [HttpGet("/api/v2/users/{id}")]
        public abstract Task<IActionResult> Read([FromRoute] string id, CancellationToken cancellationToken);

        [HttpPost("/api/v1/users")]
        [HttpPost("/api/v2/users")]
        public abstract Task<IActionResult> Create([FromBody] User body, CancellationToken cancellationToken);
    }
}
```

```csharp
// Services/IUsersService.g.cs
namespace MyApi.Services
{
    public partial interface IUsersService
    {
        Task<IList<User>?> ListAsync(CancellationToken cancellationToken);

        Task<User?> ReadAsync(string id, CancellationToken cancellationToken);

        Task<User?> CreateAsync(User body, CancellationToken cancellationToken);
    }
}
```

You then implement the controller and the service in your own, non-generated code:

```csharp
public class UsersController(IUsersService service) : UsersControllerBase
{
    public override async Task<IActionResult> List(CancellationToken cancellationToken) =>
        Ok(await service.ListAsync(cancellationToken));

    public override async Task<IActionResult> Read(string id, CancellationToken cancellationToken) =>
        await service.ReadAsync(id, cancellationToken) is { } user ? Ok(user) : NotFound();

    public override async Task<IActionResult> Create(User body, CancellationToken cancellationToken) =>
        Ok(await service.CreateAsync(body, cancellationToken));
}
```

Register the service implementation with dependency injection as usual, for example `builder.Services.AddScoped<IUsersService, UsersService>();`.

## Disabling output

Controllers and service interfaces can be disabled independently:

```yaml
options:
  "@massivescale/tsp-aspnetcore-api":
    emit-controllers: false # skip controller files
    emit-services: false # skip service interface files
```

## Related options

| Option                    | Default                        | Description                                                                                                                                 |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `abstract-suffix`         | `"Base"`                       | Suffix appended to generated abstract class names, e.g. `UsersControllerBase`.                                                              |
| `cancellation-token`      | `true`                         | When `true`, adds `CancellationToken cancellationToken` to every controller action and service method, and emits `using System.Threading;`. |
| `controller-query-params` | `"required"`                   | Which `@query` parameters become action and service method parameters: `"all"`, `"required"` (non-optional only) or `"none"`.               |
| `controllers-namespace`   | `<root-namespace>.Controllers` | Verbatim C# namespace for controller files.                                                                                                 |
| `controllers-output-dir`  | `"Controllers"`                | Destination for generated controller files.                                                                                                 |
| `route-prefix`            | `"api/{version}"`              | Prefix prepended to every action route. `{version}` becomes each API version's value, or is removed when the service has no `@versioned`.   |
| `services-namespace`      | `<root-namespace>.Services`    | Verbatim C# namespace for service interface files.                                                                                          |
| `services-output-dir`     | `"Services"`                   | Destination for generated service interface files.                                                                                          |
