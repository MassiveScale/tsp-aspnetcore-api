import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("csharp emitter - controllers", () => {
  describe("type mapping", () => {
    it("uses MergePatch<T> as the PATCH body type in controllers", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{ title: "Widgets" })
        namespace Demo;

        model Widget {
          id: string;
          name: string;
        }

        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
      `);

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(ctrl, "expected controller");
      ok(
        ctrl.includes("Demo.Helpers.MergePatch<Demo.Models.Widget>"),
        `expected MergePatch<Widget> in PATCH body in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes("WidgetPatch"),
        "expected MergePatchUpdate model to be replaced with MergePatch<Widget>",
      );
    });
  });

  describe("cancellation-token option", () => {
    const cancellationTokenSpec = `
      import "@typespec/http";
      using TypeSpec.Http;

      @service(#{title: "Items" })
      namespace Demo;

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @post create(@body item: Item): void;
      }
    `;

    it("adds CancellationToken parameter to the controller by default (cancellation-token defaults to true)", async () => {
      const results = await emit(cancellationTokenSpec, {});

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("using System.Threading;"),
        `missing 'using System.Threading;' in controller:\n${ctrl}`,
      );
      ok(
        ctrl.includes(
          "public abstract Task<IActionResult> List(CancellationToken cancellationToken);",
        ),
        `missing List in controller:\n${ctrl}`,
      );
    });

    it("adds CancellationToken parameter to the controller when cancellation-token is true", async () => {
      const results = await emit(cancellationTokenSpec, {
        "cancellation-token": true,
      });

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("using System.Threading;"),
        `missing 'using System.Threading;' in controller:\n${ctrl}`,
      );
      ok(
        ctrl.includes(
          "public abstract Task<IActionResult> List(CancellationToken cancellationToken);",
        ),
        `missing List in controller:\n${ctrl}`,
      );
      ok(
        ctrl.includes(
          "public abstract Task<IActionResult> Create([FromBody] Demo.Models.Item body, CancellationToken cancellationToken);",
        ),
        `missing Create in controller:\n${ctrl}`,
      );
    });

    it("omits CancellationToken parameter from the controller when cancellation-token is false", async () => {
      const results = await emit(cancellationTokenSpec, {
        "cancellation-token": false,
      });

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        !ctrl.includes("CancellationToken"),
        `unexpected CancellationToken in controller:\n${ctrl}`,
      );
      ok(
        !ctrl.includes("using System.Threading;"),
        `unexpected 'using System.Threading;' in controller:\n${ctrl}`,
      );
    });
  });

  describe("controller generation", () => {
    it("emits a controller for an HTTP interface", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Users" })
        namespace Demo;

        model User { id: string; name: string; }

        @route("/users")
        interface Users {
          @get list(): User[];
          @get @route("{id}") read(@path id: string): User;
          @post create(@body user: User): User;
        }
      `);

      ok(
        results["Controllers/UsersControllerBase.g.cs"],
        "expected Controllers/UsersControllerBase.g.cs",
      );
    });

    it("controller has ApiController and ControllerBase; route is on each method", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Items" })
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `);

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        !ctrl.includes("[Route("),
        `class-level [Route] should not be present:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/items")]'),
        `expected method-level route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes("[ApiController]"),
        `expected [ApiController] in:\n${ctrl}`,
      );
      ok(
        ctrl.includes("ControllerBase"),
        `expected ControllerBase in:\n${ctrl}`,
      );
    });

    it("controller is abstract", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Orders" })
        namespace Demo;

        model Order { id: string; }

        @route("/orders")
        interface Orders {
          @get list(): Order[];
        }
      `);

      const ctrl = results["Controllers/OrdersControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("public abstract class OrdersControllerBase"),
        `expected abstract class in:\n${ctrl}`,
      );
    });

    it("emits action methods with correct HTTP verb attributes", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Things" })
        namespace Demo;

        model Thing { id: string; }

        @route("/things")
        interface Things {
          @get list(): Thing[];
          @post create(@body thing: Thing): Thing;
          @get @route("{id}") read(@path id: string): Thing;
          @put @route("{id}") update(@path id: string, @body thing: Thing): Thing;
          @delete @route("{id}") remove(@path id: string): void;
        }
      `);

      const ctrl = results["Controllers/ThingsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/things")]'),
        `expected root HttpGet in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpPost("/api/things")]'),
        `expected HttpPost in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/things/{id}")]'),
        `expected HttpGet with id in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpPut("/api/things/{id}")]'),
        `expected HttpPut in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpDelete("/api/things/{id}")]'),
        `expected HttpDelete in:\n${ctrl}`,
      );
    });

    it("emits path and query parameters with correct binding attributes", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Search" })
        namespace Demo;

        model Result { id: string; }

        @route("/results")
        interface Results {
          @get search(@query q: string, @query page?: int32): Result[];
          @get @route("{id}") read(@path id: string): Result;
        }
      `);

      const ctrl = results["Controllers/ResultsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(ctrl.includes("[FromQuery]"), `expected [FromQuery] in:\n${ctrl}`);
      ok(ctrl.includes("[FromRoute]"), `expected [FromRoute] in:\n${ctrl}`);
      ok(ctrl.includes("string q"), `expected q param in:\n${ctrl}`);
      ok(
        ctrl.includes("int? page"),
        `expected optional page param in:\n${ctrl}`,
      );
      ok(ctrl.includes("string id"), `expected id param in:\n${ctrl}`);
    });

    it("emits a body parameter with [FromBody]", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Posts" })
        namespace Demo;

        model Post { title: string; }

        @route("/posts")
        interface Posts {
          @post create(@body post: Post): Post;
        }
      `);

      const ctrl = results["Controllers/PostsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(ctrl.includes("[FromBody]"), `expected [FromBody] in:\n${ctrl}`);
      ok(ctrl.includes("Post body"), `expected body param in:\n${ctrl}`);
    });

    it("generates one route attribute per API version on each method", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @service(#{title: "API" })
        @versioned(Versions)
        namespace Demo;

        enum Versions { v1, v2 }

        model Widget { id: string; }

        @route("/widgets")
        interface Widgets {
          @get list(): Widget[];
        }
      `);

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        !ctrl.includes("[Route("),
        `class-level [Route] should not be present:\n${ctrl}`,
      );
      ok(ctrl.includes("v1"), `expected v1 route in:\n${ctrl}`);
      ok(ctrl.includes("v2"), `expected v2 route in:\n${ctrl}`);
      // list() has one [HttpGet] per version
      const verbCount = (ctrl.match(/\[HttpGet\(/g) ?? []).length;
      strictEqual(
        verbCount,
        2,
        `expected 2 [HttpGet] attributes, got ${verbCount} in:\n${ctrl}`,
      );
    });

    it("includes path parameters in versioned operation routes", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @service(#{title: "API" })
        @versioned(Versions)
        namespace Demo;

        enum Versions { v1, v2 }

        model Widget { id: string; }

        @route("/widgets")
        interface Widgets {
          @get read(@path id: string): Widget;
        }
      `);

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v1/widgets/{id}")]'),
        `expected v1 id route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v2/widgets/{id}")]'),
        `expected v2 id route in:\n${ctrl}`,
      );
    });

    it("emits versioned routes only for versions where each operation exists", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @service(#{title: "API" })
        @versioned(Versions)
        namespace Demo;

        enum Versions { v1, v2, v3 }

        model Widget { id: string; }

        @route("/widgets")
        interface Widgets {
          @get list(): Widget[];

          @added(Versions.v2)
          @get @route("{id}/audit")
          audit(@path id: string): Widget;

          @removed(Versions.v3)
          @get @route("{id}/legacy")
          legacy(@path id: string): Widget;
        }
      `);

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );

      ok(
        ctrl.includes('[HttpGet("/api/v2/widgets/{id}/audit")]'),
        `expected v2 audit route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v3/widgets/{id}/audit")]'),
        `expected v3 audit route in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes('[HttpGet("/api/v1/widgets/{id}/audit")]'),
        `did not expect v1 audit route in:\n${ctrl}`,
      );

      ok(
        ctrl.includes('[HttpGet("/api/v1/widgets/{id}/legacy")]'),
        `expected v1 legacy route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v2/widgets/{id}/legacy")]'),
        `expected v2 legacy route in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes('[HttpGet("/api/v3/widgets/{id}/legacy")]'),
        `did not expect v3 legacy route in:\n${ctrl}`,
      );
    });

    it("respects operation availability when version values differ from version names", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @service(#{title: "API" })
        @versioned(Versions)
        namespace Demo;

        enum Versions {
          v1: "1.0",
          v1_1: "1.1",
          v2: "2.0",
        }

        model Widget { id: string; }

        @route("/widgets")
        interface Widgets {
          @added(Versions.v1_1)
          @post create(@body widget: Widget): Widget;
        }
      `);

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        !ctrl.includes('[HttpPost("/api/1.0/widgets")]'),
        `did not expect v1.0 create route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpPost("/api/1.1/widgets")]'),
        `expected v1.1 create route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpPost("/api/2.0/widgets")]'),
        `expected v2.0 create route in:\n${ctrl}`,
      );
    });

    it("respects route-prefix option", async () => {
      const results = await emit(
        `
          import "@typespec/http";
          using TypeSpec.Http;

          @service(#{title: "API" })
          namespace Demo;

          model Item { id: string; }

          @route("/items")
          interface Items {
            @get list(): Item[];
          }
        `,
        { "route-prefix": "v2/api" },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("v2/api/items"),
        `expected v2/api/items route in:\n${ctrl}`,
      );
    });

    it("replaces {version} token in route-prefix for versioned services", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @service(#{title: "API" })
        @versioned(Versions)
        namespace Demo;

        enum Versions { v1: "v1.0", v2: "v2.0" }

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `);

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v1.0/items")]'),
        `expected /api/v1.0/items route in:\n${ctrl}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v2.0/items")]'),
        `expected /api/v2.0/items route in:\n${ctrl}`,
      );
    });

    it("strips {version} token from route-prefix for unversioned services", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "API" })
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `);

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/items")]'),
        `expected /api/items route in:\n${ctrl}`,
      );
    });

    it("normalizes repeated slashes in the versioned {version} prefix branch", async () => {
      const results = await emit(
        `
          import "@typespec/http";
          import "@typespec/versioning";
          using TypeSpec.Http;
          using TypeSpec.Versioning;

          @service(#{title: "API" })
          @versioned(Versions)
          namespace Demo;

          enum Versions { v1: "v1.0" }

          model Item { id: string; }

          @route("/items")
          interface Items {
            @get list(): Item[];
          }
        `,
        { "route-prefix": "api//{version}" },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/api/v1.0/items")]'),
        `expected normalized /api/v1.0/items (no double slash) in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes('"/api//'),
        `did not expect double slash in route paths:\n${ctrl}`,
      );
    });

    it("supports {version} token in a custom route-prefix", async () => {
      const results = await emit(
        `
          import "@typespec/http";
          import "@typespec/versioning";
          using TypeSpec.Http;
          using TypeSpec.Versioning;

          @service(#{title: "API" })
          @versioned(Versions)
          namespace Demo;

          enum Versions { v1: "v1.0" }

          model Item { id: string; }

          @route("/items")
          interface Items {
            @get list(): Item[];
          }
        `,
        { "route-prefix": "myapp/{version}/api" },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes('[HttpGet("/myapp/v1.0/api/items")]'),
        `expected /myapp/v1.0/api/items route in:\n${ctrl}`,
      );
    });

    it("routes controller files to controllers-output-dir when configured", async () => {
      const results = await emit(
        `
          import "@typespec/http";
          using TypeSpec.Http;

          @service(#{title: "Demo" })
          namespace Demo;

          model Task { id: string; }

          @route("/tasks")
          interface Tasks {
            @get list(): Task[];
          }
        `,
        {
          "controllers-output-dir": "Controllers",
          "services-output-dir": "Services",
        },
      );

      ok(
        results["Controllers/TasksControllerBase.g.cs"],
        `expected Controllers/TasksControllerBase.g.cs, got ${Object.keys(results).join(", ")}`,
      );
    });

    it("infers controller namespace from the TypeSpec namespace when root-namespace is not set", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Items" })
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `,
        { "namespace-from-path": true },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("namespace Demo.Controllers"),
        `expected 'namespace Demo.Controllers' in:\n${ctrl}`,
      );
    });

    it("infers a multi-segment controller namespace when the TypeSpec namespace is multi-segment", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Orders" })
        namespace My.Company.Orders;

        model Order { id: string; }

        @route("/orders")
        interface Orders {
          @get list(): Order[];
        }
      `,
        { "namespace-from-path": true },
      );

      const ctrl = results["Controllers/OrdersControllerBase.g.cs"];
      ok(
        ctrl,
        `expected controller file, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("namespace My.Company.Orders.Controllers"),
        `expected 'namespace My.Company.Orders.Controllers' in:\n${ctrl}`,
      );
    });
  });

  describe("merge-patch-style: typed", () => {
    const TYPED_SPEC = `
      import "@typespec/http";
      using TypeSpec.Http;

      @service(#{ title: "Widgets" })
      namespace Demo;

      model Widget {
        id: string;
        name: string;
      }

      model WidgetPatch is MergePatchUpdate<Widget>;

      @route("/widgets/{id}")
      interface Widgets {
        @patch update(@path id: string, @body body: WidgetPatch): Widget;
      }
    `;

    it("controller uses WidgetMergePatchUpdate as the PATCH body type", async () => {
      const results = await emit(TYPED_SPEC, { "merge-patch-style": "typed" });

      const ctrl = results["Controllers/WidgetsControllerBase.g.cs"];
      ok(ctrl, "expected controller");
      ok(
        ctrl.includes("WidgetMergePatchUpdate"),
        `expected WidgetMergePatchUpdate in controller in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes("MergePatch<Widget>"),
        `expected no generic MergePatch<Widget> in typed controller in:\n${ctrl}`,
      );
    });
  });

  describe("per-section namespace options", () => {
    it("controllers-namespace sets verbatim C# namespace for all controller files", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `,
        {
          "root-namespace": "Demo",
          "controllers-namespace": "MyCompany.Web",
        },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl,
        `expected Controllers/ItemsControllerBase.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        ctrl.includes("namespace MyCompany.Web"),
        `expected 'namespace MyCompany.Web' in:\n${ctrl}`,
      );
    });

    it("controller uses the verbatim per-section override when set", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @get list(): Item[];
        }
      `,
        {
          "root-namespace": "App",
          "controllers-namespace": "MyCompany.Web",
        },
      );

      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl.includes("namespace MyCompany.Web"),
        `expected override ns in ctrl:\n${ctrl}`,
      );
    });
  });

  describe("@serverName decorator", () => {
    it("uses @serverName in controller method signatures", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using TypeSpec.Http;

        @service(#{title: "Pets" })
        namespace Demo;

        @serverName("PetResource")
        model Pet { id: string; }

        @route("/pets")
        interface Pets {
          @post create(@body body: Pet): Pet;
        }
      `);

      const ctrl =
        results["Controllers/PetsControllerBase.g.cs"] ??
        results[
          Object.keys(results).find((k) =>
            k.endsWith("PetsControllerBase.g.cs"),
          )!
        ];
      ok(ctrl, "expected controller file to be emitted");
      ok(
        ctrl.includes("[FromBody] Models.PetResource body"),
        "expected controller body parameter type to use @serverName",
      );
      ok(
        !ctrl.includes("[FromBody] Pet body"),
        "expected controller not to use raw TypeSpec model name in body parameter",
      );
    });
  });
});
