import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("csharp emitter - services", () => {
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

    it("adds CancellationToken parameter to the service by default (cancellation-token defaults to true)", async () => {
      const results = await emit(cancellationTokenSpec, {});

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service interface");
      ok(
        svc.includes("using System.Threading;"),
        `missing 'using System.Threading;' in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task<IList<Demo.Models.Item>?> ListAsync(CancellationToken cancellationToken);",
        ),
        `missing ListAsync in service:\n${svc}`,
      );
    });

    it("adds CancellationToken parameter to the service when cancellation-token is true", async () => {
      const results = await emit(cancellationTokenSpec, {
        "cancellation-token": true,
      });

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service interface");
      ok(
        svc.includes("using System.Threading;"),
        `missing 'using System.Threading;' in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task<IList<Demo.Models.Item>?> ListAsync(CancellationToken cancellationToken);",
        ),
        `missing ListAsync in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task CreateAsync(Demo.Models.Item body, CancellationToken cancellationToken);",
        ),
        `missing CreateAsync in service:\n${svc}`,
      );
    });

    it("omits CancellationToken parameter from the service when cancellation-token is false", async () => {
      const results = await emit(cancellationTokenSpec, {
        "cancellation-token": false,
      });

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service interface");
      ok(
        !svc.includes("CancellationToken"),
        `unexpected CancellationToken in service:\n${svc}`,
      );
      ok(
        !svc.includes("using System.Threading;"),
        `unexpected 'using System.Threading;' in service:\n${svc}`,
      );
    });
  });

  describe("controller generation", () => {
    it("emits a service interface for an HTTP interface", async () => {
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
        results["Services/IUsersService.g.cs"],
        "expected Services/IUsersService.g.cs",
      );
    });

    it("service interface file is emitted alongside the controller", async () => {
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

      const svc = results["Services/IOrdersService.g.cs"];
      ok(svc, `expected Services/IOrdersService.g.cs`);
      ok(
        svc.includes("public partial interface IOrdersService"),
        `expected interface decl in:\n${svc}`,
      );
    });

    it("service interface has Task<T> method signatures", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Users" })
        namespace Demo;

        model User { id: string; }

        @route("/users")
        interface Users {
          @get list(): User[];
          @get @route("{id}") read(@path id: string): User;
        }
      `);

      const svc = results["Services/IUsersService.g.cs"];
      ok(
        svc,
        `expected Services/IUsersService.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(svc.includes("Task<"), `expected Task<> in:\n${svc}`);
      ok(svc.includes("ListAsync("), `expected ListAsync method in:\n${svc}`);
      ok(svc.includes("ReadAsync("), `expected ReadAsync method in:\n${svc}`);
    });

    it("service interface declares abstract Task methods", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Users" })
        namespace Demo;

        model User { id: string; }

        @route("/users")
        interface Users {
          @get list(): User[];
        }
      `);

      const svc = results["Services/IUsersService.g.cs"];
      ok(svc, `expected Services/IUsersService.g.cs`);
      ok(
        svc.includes("public partial interface IUsersService"),
        `expected interface decl in:\n${svc}`,
      );
      ok(svc.includes("Task<"), `expected Task<> signature in:\n${svc}`);
    });

    it("service interface returns plain Task for operations with no response body", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Items" })
        namespace Demo;

        model Item { id: string; }

        @route("/items")
        interface Items {
          @delete @route("{id}") remove(@path id: string): void;
          @put @route("{id}") replace(@path id: string, @body item: Item): NoContentResponse;
        }
      `);

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, `expected Services/IItemsService.g.cs`);
      ok(
        svc.includes("Task RemoveAsync("),
        `expected plain Task for void response in:\n${svc}`,
      );
      ok(
        svc.includes("Task ReplaceAsync("),
        `expected plain Task for 204 response in:\n${svc}`,
      );
      ok(!svc.includes("Task<"), `did not expect Task<T> in:\n${svc}`);
    });

    it("service interface excludes @error models from return type", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Widgets" })
        namespace Demo;

        model Widget { id: string; }

        @error
        model ApiError { code: int32; message: string; }

        @route("/widgets")
        interface Widgets {
          @get list(): Widget[] | ApiError;
          @get @route("{id}") read(@path id: string): Widget | ApiError;
          @delete @route("{id}") remove(@path id: string): void | ApiError;
        }
      `);

      const svc = results["Services/IWidgetsService.g.cs"];
      ok(svc, `expected Services/IWidgetsService.g.cs`);
      ok(
        svc.includes("Task<IList<Demo.Models.Widget>?>"),
        `expected IList<Widget> return in:\n${svc}`,
      );
      ok(
        svc.includes("Task<Demo.Models.Widget?>"),
        `expected Widget return in:\n${svc}`,
      );
      ok(
        svc.includes("Task RemoveAsync("),
        `expected plain Task for void|error response in:\n${svc}`,
      );
      ok(
        !svc.includes("ApiError"),
        `did not expect ApiError in service interface:\n${svc}`,
      );
    });

    it("service interface uses @body type for complex responses with status codes and headers", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Widgets" })
        namespace Demo;

        model Widget { id: string; }

        @route("/widgets")
        interface Widgets {
          @post create(@body widget: Widget): {
            @statusCode status: 201;
            @header eTag: string;
            @body body: Widget;
          };
        }
      `);

      const svc = results["Services/IWidgetsService.g.cs"];
      ok(svc, `expected Services/IWidgetsService.g.cs`);
      ok(
        svc.includes("Task<Demo.Models.Widget?>"),
        `expected Task<Widget?> for @body response in:\n${svc}`,
      );
    });

    it("routes service files to services-output-dir when configured", async () => {
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
        results["Services/ITasksService.g.cs"],
        "expected Services/ITasksService.g.cs",
      );
    });

    it("infers service namespace from the TypeSpec namespace when root-namespace is not set", async () => {
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

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service file");
      ok(
        svc.includes("namespace Demo.Services"),
        `expected 'namespace Demo.Services' in:\n${svc}`,
      );
    });
  });

  describe("per-section namespace options", () => {
    it("services-namespace sets verbatim C# namespace for all service files", async () => {
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
          "services-namespace": "MyCompany.Application",
        },
      );

      const svc = results["Services/IItemsService.g.cs"];
      ok(
        svc,
        `expected Services/IItemsService.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        svc.includes("namespace MyCompany.Application"),
        `expected 'namespace MyCompany.Application' in:\n${svc}`,
      );
    });

    it("service defaults to root-namespace.Services when unset", async () => {
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

      const svc = results["Services/IItemsService.g.cs"];
      ok(
        svc.includes("namespace App.Services"),
        `expected default ns in svc:\n${svc}`,
      );
    });
  });

  describe("@serverName decorator", () => {
    it("uses @serverName in service method signatures", async () => {
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

      const svc =
        results["Services/IPetsService.g.cs"] ??
        results[
          Object.keys(results).find((k) => k.endsWith("IPetsService.g.cs"))!
        ];
      ok(svc, "expected service interface file to be emitted");
      ok(
        svc.includes(
          "Task<Models.PetResource?> CreateAsync(Models.PetResource body",
        ),
        "expected service method signature to use @serverName for parameter and return type",
      );
      ok(
        !svc.includes("Task<Pet?> CreateAsync(Pet body"),
        "expected service signature not to use raw TypeSpec model name",
      );
    });
  });
});
