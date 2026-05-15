# Controllers and Services

When the TypeSpec source includes `@typespec/http` operations, the emitter produces ASP.NET Core controllers and matching service interfaces.

For each HTTP `interface` (or `namespace`) that carries routes, the emitter writes:

| File                      | Content                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `<Name>ControllerBase.cs` | Abstract ASP.NET Core controller inheriting `ControllerBase`. Injects `I<Name>Service` and delegates every action to the service. |
| `I<Name>Service.cs`       | Service interface with one `Task<T>` method per operation.                                                                        |

**Routes** — one `[Http<Verb>("...")]` attribute is emitted per available API version of each operation. Without versioning a single attribute is emitted using the resolved operation path.

**Parameter binding** — path parameters get `[FromRoute]`, query parameters get `[FromQuery]`, headers get `[FromHeader]`, and request bodies get `[FromBody]`.

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
public interface IUsersService
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
    emit-controllers: false   # skip controller files
    emit-services: false      # skip service interface files
```

## Related options

| Option                       | Default         | Description                                                                         |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `controllers-output-dir`     | `"Controllers"` | Destination for generated controller files.                                         |
| `controllers-root-namespace` | _(global root)_ | Root namespace for controller files.                                                |
| `services-output-dir`        | `"Services"`    | Destination for generated service interface files.                                  |
| `services-root-namespace`    | _(global root)_ | Root namespace for service interface files.                                         |
| `route-prefix`               | `"api"`         | Prefix prepended to every controller route, e.g. `"api"` → `/api/v1/users`.        |
| `abstract-suffix`            | `"Base"`        | Suffix appended to generated abstract class names, e.g. `UsersControllerBase`.     |
