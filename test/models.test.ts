import { ok, strictEqual } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

function writeTemplate(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csharp-tpl-"));
  const file = join(dir, `${name}.hbs`);
  writeFileSync(file, content);
  return file;
}

describe("csharp emitter - models", () => {
  describe("default layout (no root-namespace)", () => {
    it("emits each model flat at the root of the output dir", async () => {
      const results = await emit(`
        namespace Demo;
        model Person { name: string; age: int32; }
        model Address { city: string; }
      `);

      ok(results["Person.g.cs"], "expected Person.cs at root");
      ok(results["Address.g.cs"], "expected Address.cs at root");
      // Helpers are always emitted to a Helpers/ subdir — exclude them from the
      // flat-layout check, which only concerns model and interface files.
      const nonHelperKeys = Object.keys(results).filter(
        (k) => !k.startsWith("Helpers/"),
      );
      ok(
        nonHelperKeys.every((k) => k.startsWith("Models/")),
        "expected model/interface files under Models/",
      );
    });

    it("uses default namespace for top-level models", async () => {
      const results = await emit(`model Loose { x: int32; }`);
      const file = results["Loose.g.cs"];
      ok(file, "expected Loose.cs at root");
      ok(file.includes("namespace Models"));
    });

    it("uses original TypeSpec namespace as the C# namespace", async () => {
      const results = await emit(`
        namespace App.Users;
        model User { id: string; }
      `);
      const file = results["User.g.cs"];
      ok(file, "expected User.cs at root");
      ok(file.includes("namespace App.Users"));
    });
  });

  describe("root-namespace option", () => {
    it("namespace-from-path places model files flat in the output dir", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        { "root-namespace": "App", "namespace-from-path": true },
      );

      const file = results["Models/User.g.cs"];
      ok(
        file,
        `expected Models/User.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(file.includes("namespace App.Models"));
    });

    it("places models at root when their namespace equals the root namespace", async () => {
      const results = await emit(
        `
          namespace App;
          model Root { id: string; }
        `,
        { "root-namespace": "App" },
      );

      const file = results["Root.g.cs"];
      ok(file, "expected Root.cs at output root");
      ok(file.includes("namespace App"));
    });

    it("places top-level models at root with the root namespace as their C# namespace", async () => {
      const results = await emit(`model Free { id: string; }`, {
        "root-namespace": "App",
      });

      const file = results["Free.g.cs"];
      ok(file, "expected Free.g.cs");
      ok(file.includes("namespace App"));
    });

    it("models outside the root namespace are placed at the output root", async () => {
      const results = await emit(
        `
          namespace Other.Stuff;
          model Foreign { id: string; }
        `,
        { "root-namespace": "App" },
      );

      const file = results["Foreign.g.cs"];
      ok(file, "expected Foreign.cs at root");
      ok(file.includes("namespace App.Models"));
    });

    it("supports nested root namespace prefixes", async () => {
      const results = await emit(
        `
          namespace App.Api.V1.Users;
          model User { id: string; }
        `,
        { "root-namespace": "App.Api", "namespace-from-path": true },
      );

      const file = results["Models/User.g.cs"];
      ok(
        file,
        `expected Models/User.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(file.includes("namespace App.Api.Models"));
    });
  });

  describe("@format-based type mapping", () => {
    it("maps uuid to Guid", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("uuid") id: string; }
      `);
      ok(results["M.g.cs"].includes("public Guid? Id { get; set; }"));
    });

    it("maps guid (alias) to Guid", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("guid") id: string; }
      `);
      ok(results["M.g.cs"].includes("public Guid? Id { get; set; }"));
    });

    it("maps uri to Uri", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("uri") link: string; }
      `);
      ok(results["M.g.cs"].includes("public Uri? Link { get; set; }"));
    });

    it("maps date-time format to DateTimeOffset", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("date-time") at: string; }
      `);
      ok(results["M.g.cs"].includes("public DateTimeOffset? At { get; set; }"));
    });

    it("preserves nullable on optional formatted properties", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("uuid") id?: string; }
      `);
      ok(results["M.g.cs"].includes("public Guid? Id { get; set; }"));
    });

    it("falls back to the underlying type when the format is unknown", async () => {
      const results = await emit(`
        namespace Demo;
        model M { @format("unknown-thing") name: string; }
      `);
      ok(results["M.g.cs"].includes("public string? Name { get; set; }"));
    });
  });

  describe("type mapping", () => {
    it("emits a simple model with primitive properties", async () => {
      const results = await emit(`
        namespace Demo;
        model Person { name: string; age: int32; active: boolean; }
      `);

      const file = results["Person.g.cs"];
      ok(file.includes("public partial class Person"));
      ok(file.includes("public string? Name { get; set; }"));
      ok(file.includes("public int? Age { get; set; }"));
      ok(file.includes("public bool? Active { get; set; }"));
    });

    it("treats optional properties as nullable", async () => {
      const results = await emit(`
        namespace Demo;
        model Thing { id: string; nickname?: string; count?: int32; }
      `);

      const file = results["Thing.g.cs"];
      ok(file.includes("public string? Id { get; set; }"));
      ok(file.includes("public string? Nickname { get; set; }"));
      ok(file.includes("public int? Count { get; set; }"));
    });

    it("maps array and record types", async () => {
      const results = await emit(`
        namespace Demo;
        model Bag { tags: string[]; scores: Record<int32>; }
      `);

      const file = results["Bag.g.cs"];
      ok(file.includes("public IList<string>? Tags { get; set; }"));
      ok(
        file.includes("public IDictionary<string, int>? Scores { get; set; }"),
      );
    });

    it("resolves inferred enum types in versioned models", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service(#{ title: "Widget Service" })
        namespace Demo;

        enum Versions {
          v1_0: "1.0",
          v2_0: "2.0",
        }

        model Widget {
          color: "red" | "blue";
        }
      `);

      const widget = results["Models/Widget.g.cs"];
      ok(
        widget,
        `expected Models/Widget.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        widget.includes("public Demo.Models.WidgetColor? Color { get; set; }"),
        `expected WidgetColor in:\n${widget}`,
      );
      ok(
        !widget.includes("public object? Color { get; set; }"),
        `did not expect object for Color in:\n${widget}`,
      );

      const inferredEnum = results["Models/WidgetColor.g.cs"];
      ok(
        inferredEnum,
        `expected inferred enum Models/WidgetColor.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        inferredEnum.includes("public enum WidgetColor"),
        `expected WidgetColor enum in:\n${inferredEnum}`,
      );
      ok(
        inferredEnum.includes('EnumMember(Value = "red")'),
        `expected red member value in:\n${inferredEnum}`,
      );
      ok(
        inferredEnum.includes('EnumMember(Value = "blue")'),
        `expected blue member value in:\n${inferredEnum}`,
      );
    });

    it("does not emit Patch method on models merely named MergePatchUpdate", async () => {
      const results = await emit(`
        namespace Demo;

        model WidgetMergePatchUpdate {
          name: string;
        }
      `);

      const file =
        results["WidgetMergePatchUpdate.g.cs"] ??
        results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(
        file,
        `expected WidgetMergePatchUpdate.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        !file.includes("public void Patch("),
        `expected no Patch method on a plain model in:\n${file}`,
      );
    });

    it("emits enums with numeric values", async () => {
      const results = await emit(`
        namespace Demo;
        enum Color { Red: 1, Green: 2, Blue: 3 }
      `);

      const file = results["Color.g.cs"];
      ok(file.includes("public enum Color"));
      ok(file.includes("Red = 1"));
      ok(file.includes("Green = 2"));
      ok(file.includes("Blue = 3"));
    });

    it("emits inheritance via extends", async () => {
      const results = await emit(`
        namespace Demo;
        model Animal { name: string; }
        model Dog extends Animal { breed: string; }
      `);

      const animal = results["Animal.g.cs"];
      const dog = results["Dog.g.cs"];
      ok(animal.includes("public partial class Animal"));
      ok(dog.includes("public partial class Dog : Demo.Models.Animal"));
    });

    it("treats nullable unions as nullable C# types", async () => {
      const results = await emit(`
        namespace Demo;
        model M { value: string | null; }
      `);
      ok(results["M.g.cs"].includes("public string? Value { get; set; }"));
    });

    it("maps date and duration scalars", async () => {
      const results = await emit(`
        namespace Demo;
        model M {
          when: utcDateTime;
          date: plainDate;
          time: plainTime;
          dur: duration;
        }
      `);
      const file = results["M.g.cs"];
      ok(file.includes("public DateTimeOffset? When { get; set; }"));
      ok(file.includes("public DateOnly? Date { get; set; }"));
      ok(file.includes("public TimeOnly? Time { get; set; }"));
      ok(file.includes("public TimeSpan? Dur { get; set; }"));
    });

    it("emits doc comments as XML summary", async () => {
      const results = await emit(`
        namespace Demo;
        @doc("A user of the system")
        model User {
          @doc("Unique id")
          id: string;
        }
      `);
      const file = results["User.g.cs"];
      ok(file.includes("/// <summary>"));
      ok(file.includes("/// A user of the system"));
      ok(file.includes("/// Unique id"));
    });

    it("ignores standard library types", async () => {
      const results = await emit(
        `
        namespace Demo;
        model X { v: string; }
      `,
        { "emit-interfaces": true },
      );
      // Helpers (Helpers/*.g.cs) are always emitted — filter them out and verify
      // only the model class and interface are produced.
      const modelFiles = Object.keys(results)
        .filter((k) => !k.startsWith("Helpers/"))
        .sort();
      strictEqual(modelFiles.length, 2);
      strictEqual(modelFiles[0], "Models/IX.g.cs");
      strictEqual(modelFiles[1], "Models/X.g.cs");
    });
  });

  describe("default property values", () => {
    it("assigns an enum default value as an initializer", async () => {
      const results = await emit(`
        namespace Demo;
        enum Size { small, medium, large }
        model Widget { size: Size = Size.medium; }
      `);

      const file = results["Widget.g.cs"] ?? results["Models/Widget.g.cs"];
      ok(file, `expected Widget.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        file.includes(
          "public Demo.Models.Size? Size { get; set; } = Demo.Models.Size.Medium;",
        ),
        `expected enum default initializer in:\n${file}`,
      );
    });

    it("assigns a string default value as an initializer", async () => {
      const results = await emit(`
        namespace Demo;
        model Config { env: string = "production"; }
      `);

      const file = results["Config.g.cs"] ?? results["Models/Config.g.cs"];
      ok(file, `expected Config.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        file.includes('public string? Env { get; set; } = "production";'),
        `expected string default initializer in:\n${file}`,
      );
    });

    it("assigns a numeric default value as an initializer", async () => {
      const results = await emit(`
        namespace Demo;
        model Pagination { pageSize: int32 = 20; }
      `);

      const file =
        results["Pagination.g.cs"] ?? results["Models/Pagination.g.cs"];
      ok(
        file,
        `expected Pagination.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        file.includes("public int? PageSize { get; set; } = 20;"),
        `expected numeric default initializer in:\n${file}`,
      );
    });

    it("assigns a boolean default value as an initializer", async () => {
      const results = await emit(`
        namespace Demo;
        model Feature { enabled: boolean = true; }
      `);

      const file = results["Feature.g.cs"] ?? results["Models/Feature.g.cs"];
      ok(file, `expected Feature.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        file.includes("public bool? Enabled { get; set; } = true;"),
        `expected boolean default initializer in:\n${file}`,
      );
    });

    it("does not emit an initializer when no default is present", async () => {
      const results = await emit(`
        namespace Demo;
        model Widget { name: string; }
      `);

      const file = results["Widget.g.cs"] ?? results["Models/Widget.g.cs"];
      ok(file, `expected Widget.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        file.includes("public string? Name { get; set; }") &&
          !file.includes("public string? Name { get; set; } ="),
        `expected no initializer when no default in:\n${file}`,
      );
    });
  });

  describe("using statements", () => {
    it("does not add a using for the model's own namespace", async () => {
      const results = await emit(`
        namespace Demo;
        model A { id: string; }
        model B { ref: A; }
      `);
      const file = results["B.g.cs"];
      ok(!file.includes("using Demo;"), `unexpected self-using in:\n${file}`);
      ok(file.includes("public Demo.Models.A? Ref { get; set; }"));
    });

    it("does not add cross-namespace usings when all models share the flat models namespace", async () => {
      const results = await emit(
        `
        namespace App.Common { model Address { city: string; } }
        namespace App.Users { model User { home: App.Common.Address; } }
      `,
        { "namespace-from-path": true },
      );
      const file = results["User.g.cs"];
      ok(file.includes("namespace App.Models"));
      // All models share App.Models — no cross-namespace using needed
      ok(
        !file.includes("using App.Common"),
        `unexpected cross-ns using in:\n${file}`,
      );
      ok(file.includes("public App.Models.Address? Home { get; set; }"));
    });

    it("does not add usings for array and record element types in the models namespace", async () => {
      const results = await emit(
        `
        namespace App.Common { model Tag { name: string; } }
        namespace App.Users {
          model User {
            tags: App.Common.Tag[];
            scoresByTag: Record<App.Common.Tag>;
          }
        }
      `,
        { "namespace-from-path": true },
      );
      const file = results["User.g.cs"];
      ok(
        !file.includes("using App.Common"),
        `unexpected cross-ns using in:\n${file}`,
      );
      ok(file.includes("public IList<App.Models.Tag>? Tags { get; set; }"));
      ok(
        file.includes(
          "public IDictionary<string, App.Models.Tag>? ScoresByTag { get; set; }",
        ),
      );
    });

    it("does not add usings for base models in the models namespace", async () => {
      const results = await emit(
        `
        namespace App.Base { model Entity { id: string; } }
        namespace App.Users { model User extends App.Base.Entity { name: string; } }
      `,
        { "namespace-from-path": true },
      );
      const file = results["User.g.cs"];
      ok(
        !file.includes("using App.Base"),
        `unexpected cross-ns using in:\n${file}`,
      );
      ok(file.includes("public partial class User : App.Models.Entity"));
    });
  });

  describe("namespace-map option", () => {
    it("models-namespace option sets the verbatim C# namespace for all model files", async () => {
      const results = await emit(
        `
          namespace Foo.Bar;
          model Widget { id: string; }
        `,
        { "models-namespace": "Acme.Things" },
      );
      const file = results["Widget.g.cs"];
      ok(file, `expected Widget.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        file.includes("namespace Acme.Things"),
        `wrong namespace in:\n${file}`,
      );
    });

    it("namespace-map applies prefix replacement for folder placement when namespace-from-path is disabled", async () => {
      const results = await emit(
        `
          namespace Foo.Bar.Sub;
          model Widget { id: string; }
        `,
        {
          "root-namespace": "Acme",
          "namespace-map": { "Foo.Bar": "Acme.Things" },
        },
      );
      // "Foo.Bar.Sub" mapped to "Acme.Things.Sub"; folderSegments("Acme","Acme.Things.Sub") → ["Things","Sub"]
      const file = results["Models/Things/Sub/Widget.g.cs"];
      ok(
        file,
        `expected mapped folder path, got ${Object.keys(results).join(", ")}`,
      );
    });

    it("uses the longest matching namespace-map key for folder placement", async () => {
      const results = await emit(
        `
          namespace Foo.Bar.Sub;
          model Widget { id: string; }
        `,
        {
          "root-namespace": "Acme",
          "namespace-map": {
            Foo: "Acme.X",
            "Foo.Bar": "Acme.Things",
          },
        },
      );
      // longest match "Foo.Bar" wins over "Foo" → "Acme.Things.Sub" → folder ["Things","Sub"]
      const file = results["Models/Things/Sub/Widget.g.cs"];
      ok(
        file,
        `expected longest-match folder path, got ${Object.keys(results).join(", ")}`,
      );
    });

    it("model files do not need cross-namespace usings in the flat models namespace", async () => {
      const results = await emit(
        `
          namespace Legacy.Common { model Address { city: string; } }
          namespace App.Users { model User { home: Legacy.Common.Address; } }
        `,
        { "namespace-map": { "Legacy.Common": "Acme.Common" } },
      );
      const file = results["User.g.cs"];
      // With flat namespace all models share modelsNamespace — no usings needed
      ok(
        !file.includes("using Acme.Common"),
        `unexpected mapped using in:\n${file}`,
      );
      ok(
        !file.includes("using Legacy.Common"),
        `unexpected original using in:\n${file}`,
      );
      ok(file.includes("public Models.Address? Home { get; set; }"));
    });

    it("places models in folders derived from the mapped namespace when namespace-from-path is disabled", async () => {
      const results = await emit(
        `
          namespace Legacy.Common;
          model Address { city: string; }
        `,
        {
          "root-namespace": "Acme",
          "namespace-map": { "Legacy.Common": "Acme.Common" },
        },
      );
      // "Legacy.Common" → "Acme.Common"; folderSegments("Acme","Acme.Common") = ["Common"]
      const file = results["Models/Common/Address.g.cs"];
      ok(
        file,
        `expected Models/Common/Address.cs, got ${Object.keys(results).join(", ")}`,
      );
      // model namespace is still the flat modelsNamespace, not affected by namespace-map
      ok(
        file.includes("namespace Acme.Models"),
        `wrong namespace in:\n${file}`,
      );
    });

    it("does not add a using when the mapped namespace equals the consumer's namespace", async () => {
      const results = await emit(
        `
          namespace Legacy.Common { model Address { city: string; } }
          namespace App.Users { model User { home: Legacy.Common.Address; } }
        `,
        { "namespace-map": { "Legacy.Common": "App.Users" } },
      );
      const file = results["User.g.cs"];
      ok(
        !file.includes("using App.Users;"),
        `unexpected self-using in:\n${file}`,
      );
      ok(file.includes("public Models.Address? Home { get; set; }"));
    });
  });

  describe("interface generation", () => {
    it("emits a corresponding I<Model> interface alongside each class", async () => {
      const results = await emit(
        `
        namespace Demo;
        model User { id: string; name: string; }
      `,
        { "emit-interfaces": true },
      );

      const cls = results["User.g.cs"];
      const iface = results["IUser.g.cs"];
      ok(cls, "expected User.g.cs");
      ok(iface, "expected IUser.g.cs");

      ok(cls.includes("public partial class User : Demo.Models.IUser"));
      ok(cls.includes("public string? Id { get; set; }"));

      ok(iface.includes("public partial interface IUser"));
      ok(iface.includes("string? Id { get; set; }"));
      ok(iface.includes("string? Name { get; set; }"));
      ok(
        !iface.includes("public string"),
        "interface members should not have access modifiers",
      );
    });

    it("includes the interface alongside the base class on extends", async () => {
      const results = await emit(
        `
        namespace Demo;
        model Animal { name: string; }
        model Dog extends Animal { breed: string; }
      `,
        { "emit-interfaces": true },
      );

      const dogClass = results["Dog.g.cs"];
      const dogIface = results["IDog.g.cs"];

      ok(
        dogClass.includes(
          "public partial class Dog : Demo.Models.Animal, Demo.Models.IDog",
        ),
      );
      ok(
        dogIface.includes(
          "public partial interface IDog : Demo.Models.IAnimal",
        ),
      );
      ok(dogIface.includes("string? Breed { get; set; }"));
    });

    it("does not generate interfaces for enums", async () => {
      const results = await emit(`
        namespace Demo;
        enum Color { Red, Green, Blue }
      `);

      ok(results["Color.g.cs"]);
      ok(!results["IColor.g.cs"], "enums should not have interfaces");
    });

    it("preserves nullable formatting on interface members", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M { @format("uuid") id?: string; nick?: string; }
      `,
        { "emit-interfaces": true },
      );
      const iface = results["IM.g.cs"];
      ok(iface.includes("Guid? Id { get; set; }"));
      ok(iface.includes("string? Nick { get; set; }"));
    });
  });

  describe("models-output-dir / interfaces-output-dir", () => {
    it("routes class files into models-output-dir", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "emit-interfaces": true, "models-output-dir": "models" },
      );

      ok(
        results["models/User.g.cs"],
        `expected models/User.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        results["Models/IUser.g.cs"],
        "interface should still be at default Models output dir",
      );
      ok(
        !results["User.g.cs"],
        "class should not be at default location when override is set",
      );
    });

    it("routes interface files into interfaces-output-dir", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "emit-interfaces": true, "interfaces-output-dir": "interfaces" },
      );

      ok(
        results["User.g.cs"],
        "class should still be at default emitter-output-dir",
      );
      ok(results["interfaces/IUser.g.cs"]);
      ok(
        !results["IUser.g.cs"],
        "interface should not be at default location when override is set",
      );
    });

    it("routes both when both overrides are provided", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        {
          "emit-interfaces": true,
          "models-output-dir": "src/models",
          "interfaces-output-dir": "src/interfaces",
        },
      );

      ok(results["src/models/User.g.cs"]);
      ok(results["src/interfaces/IUser.g.cs"]);
    });

    it("namespace-from-path places files flat in their output dirs with the flat models namespace", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        {
          "emit-interfaces": true,
          "root-namespace": "App",
          "models-output-dir": "models",
          "interfaces-output-dir": "interfaces",
          "namespace-from-path": true,
        },
      );

      // Files are flat under each output dir; all share the flat models namespace.
      ok(
        results["models/User.g.cs"],
        `expected flat models/User.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        results["interfaces/IUser.g.cs"],
        "expected flat interfaces/IUser.g.cs",
      );
      ok(results["models/User.g.cs"].includes("namespace App.Models"));
      ok(results["interfaces/IUser.g.cs"].includes("namespace App.Models"));
    });

    it("uses subfolder layout (not dir-suffix) when namespace-from-path is disabled", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        {
          "emit-interfaces": true,
          "root-namespace": "App",
          "models-output-dir": "models",
          "interfaces-output-dir": "interfaces",
          "namespace-from-path": false,
        },
      );

      ok(
        results["models/Users/User.g.cs"],
        `expected models/Users/User.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(results["interfaces/Users/IUser.g.cs"]);
    });

    it("routes enums to models-output-dir", async () => {
      const results = await emit(
        `
          namespace Demo;
          enum Color { Red, Green }
        `,
        { "models-output-dir": "models" },
      );

      ok(results["models/Color.g.cs"]);
      ok(!results["Color.g.cs"]);
    });
  });

  describe("additional-usings option", () => {
    it("appends configured usings to every emitted file", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
          enum Color { Red, Green }
        `,
        {
          "emit-interfaces": true,
          "additional-usings": ["System.Text.Json", "Newtonsoft.Json"],
        },
      );

      for (const key of ["User.g.cs", "IUser.g.cs", "Color.g.cs"]) {
        const file = results[key];
        ok(file, `expected ${key}`);
        ok(
          file.includes("using System.Text.Json;"),
          `missing System.Text.Json in ${key}`,
        );
        ok(
          file.includes("using Newtonsoft.Json;"),
          `missing Newtonsoft.Json in ${key}`,
        );
      }
    });

    it("places System namespaces before non-System ones", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "additional-usings": ["Newtonsoft.Json", "System.Text.Json"] },
      );

      const file = results["User.g.cs"];
      const sysIdx = file.indexOf("using System;");
      const sysJsonIdx = file.indexOf("using System.Text.Json;");
      const newtonIdx = file.indexOf("using Newtonsoft.Json;");
      ok(sysIdx >= 0 && sysJsonIdx >= 0 && newtonIdx >= 0);
      ok(sysIdx < newtonIdx, "System should come before Newtonsoft");
      ok(
        sysJsonIdx < newtonIdx,
        "System.Text.Json should come before Newtonsoft",
      );
    });

    it("does not duplicate a using already implied by a cross-namespace reference", async () => {
      const results = await emit(
        `
          namespace App.Common { model Address { city: string; } }
          namespace App.Users { model User { home: App.Common.Address; } }
        `,
        {
          "namespace-from-path": true,
          "additional-usings": ["App.Common.Models"],
        },
      );
      const file = results["Models/User.g.cs"];
      const occurrences = file.split("using App.Common.Models;").length - 1;
      strictEqual(
        occurrences,
        1,
        `expected exactly one 'using App.Common.Models;' in:\n${file}`,
      );
    });
  });

  describe("nullable-properties option", () => {
    it("renders all properties as nullable by default", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M {
          name: string;
          age: int32;
          tags: string[];
        }
      `,
        { "emit-interfaces": true },
      );
      const cls = results["M.g.cs"];
      ok(cls.includes("public string? Name { get; set; }"));
      ok(cls.includes("public int? Age { get; set; }"));
      ok(cls.includes("public IList<string>? Tags { get; set; }"));

      const iface = results["IM.g.cs"];
      ok(iface.includes("string? Name { get; set; }"));
      ok(iface.includes("int? Age { get; set; }"));
      ok(iface.includes("IList<string>? Tags { get; set; }"));
    });

    it("only marks optional properties as nullable when disabled", async () => {
      const results = await emit(
        `
          namespace Demo;
          model M {
            id: string;
            nickname?: string;
            count: int32;
            score?: int32;
          }
        `,
        { "emit-interfaces": true, "nullable-properties": false },
      );
      const cls = results["M.g.cs"];
      ok(cls.includes("public string Id { get; set; }"));
      ok(cls.includes("public string? Nickname { get; set; }"));
      ok(cls.includes("public int Count { get; set; }"));
      ok(cls.includes("public int? Score { get; set; }"));

      const iface = results["IM.g.cs"];
      ok(iface.includes("string Id { get; set; }"));
      ok(iface.includes("string? Nickname { get; set; }"));
      ok(iface.includes("int Count { get; set; }"));
      ok(iface.includes("int? Score { get; set; }"));
    });

    it("still treats null-union properties as nullable when disabled", async () => {
      const results = await emit(
        `
          namespace Demo;
          model M { value: string | null; required: string; }
        `,
        { "nullable-properties": false },
      );
      const cls = results["M.g.cs"];
      ok(cls.includes("public string? Value { get; set; }"));
      ok(cls.includes("public string Required { get; set; }"));
    });

    it("does not double up the nullability marker on already-nullable types", async () => {
      const results = await emit(`
        namespace Demo;
        model M { value: string | null; }
      `);
      const cls = results["M.g.cs"];
      ok(cls.includes("public string? Value { get; set; }"));
      ok(!cls.includes("string??"));
    });
  });

  describe("JSON serialization attributes", () => {
    it("adds [JsonPropertyName] with camelCase key to every class property", async () => {
      const results = await emit(`
        namespace Demo;
        model M { firstName: string; userId: string; }
      `);
      const cls = results["M.g.cs"];
      ok(
        cls.includes('[JsonPropertyName("firstName")]'),
        `missing firstName attr in:\n${cls}`,
      );
      ok(
        cls.includes('[JsonPropertyName("userId")]'),
        `missing userId attr in:\n${cls}`,
      );
    });

    it("converts snake_case property names to camelCase JSON keys", async () => {
      const results = await emit(`
        namespace Demo;
        model M { first_name: string; user_id: string; }
      `);
      const cls = results["M.g.cs"];
      ok(
        cls.includes('[JsonPropertyName("firstName")]'),
        `missing firstName attr in:\n${cls}`,
      );
      ok(
        cls.includes('[JsonPropertyName("userId")]'),
        `missing userId attr in:\n${cls}`,
      );
    });

    it("adds [JsonIgnore] to nullable properties but not non-nullable", async () => {
      const results = await emit(
        `
          namespace Demo;
          model M { required: string; optional?: string; }
        `,
        { "nullable-properties": false },
      );
      const cls = results["M.g.cs"];
      ok(
        cls.includes(
          "[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]",
        ),
        `missing JsonIgnore in:\n${cls}`,
      );
      // Count occurrences: only the nullable optional property should have it
      const count = (cls.match(/\[JsonIgnore\(/g) ?? []).length;
      strictEqual(count, 1, `expected 1 JsonIgnore, got ${count} in:\n${cls}`);
    });

    it("adds [JsonPropertyName] and [JsonIgnore] to interface properties", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M { name: string; }
      `,
        { "emit-interfaces": true },
      );
      const iface = results["IM.g.cs"];
      ok(
        iface.includes('[JsonPropertyName("name")]'),
        `missing JsonPropertyName in:\n${iface}`,
      );
      ok(
        iface.includes(
          "[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]",
        ),
        `missing JsonIgnore in:\n${iface}`,
      );
    });

    it("adds [JsonConverter(typeof(EnumMemberConverterFactory))] to enums", async () => {
      const results = await emit(`
        namespace Demo;
        enum Color { Red, Green, Blue }
      `);
      const file = results["Color.g.cs"];
      ok(
        file.includes("[JsonConverter(typeof(EnumMemberConverterFactory))]"),
        `missing converter in:\n${file}`,
      );
    });

    it("includes using System.Text.Json.Serialization in model files", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M { id: string; }
        enum Status { Active, Inactive }
      `,
        { "emit-interfaces": true },
      );
      ok(results["M.g.cs"].includes("using System.Text.Json.Serialization;"));
      ok(results["IM.g.cs"].includes("using System.Text.Json.Serialization;"));
      ok(
        results["Status.g.cs"].includes(
          "using System.Text.Json.Serialization;",
        ),
      );
    });
  });

  describe("@discriminator decorator", () => {
    it("adds [JsonPolymorphic] and [JsonDerivedType] to the base class", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
        model Cat extends Pet { kind: "cat"; }
      `);
      const pet = results["Pet.g.cs"];
      ok(
        pet.includes(
          '[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]',
        ),
        `missing JsonPolymorphic in:\n${pet}`,
      );
      ok(
        pet.includes('[JsonDerivedType(typeof(Demo.Models.Dog), "dog")]'),
        `missing Dog JsonDerivedType in:\n${pet}`,
      );
      ok(
        pet.includes('[JsonDerivedType(typeof(Demo.Models.Cat), "cat")]'),
        `missing Cat JsonDerivedType in:\n${pet}`,
      );
    });

    it("omits the discriminator property from the base class", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
      `);
      const pet = results["Pet.g.cs"];
      ok(
        !pet.includes("Kind"),
        `Kind property leaked into base class:\n${pet}`,
      );
      ok(pet.includes("Name"), `expected Name property in:\n${pet}`);
    });

    it("omits the discriminator property from derived classes and adds no polymorphic attributes there", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
      `);
      const dog = results["Dog.g.cs"];
      ok(
        !dog.includes("Kind"),
        `Kind property leaked into derived class:\n${dog}`,
      );
      ok(
        !dog.includes("JsonPolymorphic") && !dog.includes("JsonDerivedType"),
        `unexpected polymorphic attribute on derived class:\n${dog}`,
      );
      ok(dog.includes("public partial class Dog : Demo.Models.Pet"), dog);
    });

    it("resolves discriminator values through an intermediate model with no own literal value", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Mammal extends Pet {}
        model Dog extends Mammal { kind: "dog"; }
      `);
      const pet = results["Pet.g.cs"];
      ok(
        pet.includes('[JsonDerivedType(typeof(Demo.Models.Dog), "dog")]'),
        `missing recursive Dog JsonDerivedType in:\n${pet}`,
      );
      ok(
        !pet.includes("Mammal"),
        `Mammal (no own discriminator value) should not appear in:\n${pet}`,
      );
    });

    it("resolves discriminator values from a string-valued enum member type", async () => {
      const results = await emit(`
        namespace Demo;
        enum PetKind { Dog: "dog", Cat: "cat" }
        @discriminator("kind")
        model Pet { kind: PetKind; name: string; }
        model Dog extends Pet { kind: PetKind.Dog; }
        model Cat extends Pet { kind: PetKind.Cat; }
      `);
      const pet = results["Pet.g.cs"];
      ok(
        pet.includes('[JsonDerivedType(typeof(Demo.Models.Dog), "dog")]'),
        `missing Dog JsonDerivedType in:\n${pet}`,
      );
      ok(
        pet.includes('[JsonDerivedType(typeof(Demo.Models.Cat), "cat")]'),
        `missing Cat JsonDerivedType in:\n${pet}`,
      );
      ok(
        !pet.includes("Kind"),
        `Kind property leaked into base class:\n${pet}`,
      );
    });

    it("orders [JsonDerivedType] attributes deterministically by discriminator value", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Zebra extends Pet { kind: "zebra"; }
        model Ant extends Pet { kind: "ant"; }
      `);
      const pet = results["Pet.g.cs"];
      const antIndex = pet.indexOf(
        '[JsonDerivedType(typeof(Demo.Models.Ant), "ant")]',
      );
      const zebraIndex = pet.indexOf(
        '[JsonDerivedType(typeof(Demo.Models.Zebra), "zebra")]',
      );
      ok(antIndex !== -1 && zebraIndex !== -1, pet);
      ok(antIndex < zebraIndex, `expected Ant before Zebra in:\n${pet}`);
    });

    it("declares the base class abstract", async () => {
      const results = await emit(`
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
      `);
      const pet = results["Pet.g.cs"];
      const dog = results["Dog.g.cs"];
      ok(
        pet.includes("public abstract partial class Pet"),
        `expected Pet to be abstract:\n${pet}`,
      );
      ok(
        dog.includes("public partial class Dog : Demo.Models.Pet") &&
          !dog.includes("abstract"),
        `expected Dog to stay concrete:\n${dog}`,
      );
    });

    it("omits the discriminator property from the companion interface", async () => {
      const results = await emit(
        `
        namespace Demo;
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
      `,
        { "emit-interfaces": true },
      );
      const iface = results["IPet.g.cs"];
      ok(
        !iface.includes("Kind"),
        `Kind property leaked into interface:\n${iface}`,
      );
      ok(iface.includes("Name"), `expected Name property in:\n${iface}`);
    });
  });

  describe("templates option", () => {
    it("uses a custom class template when provided", async () => {
      const tpl = writeTemplate(
        "class",
        `[Serializable]
public partial class {{className}} : {{bases}}
{
{{#each properties}}    public {{type}} {{name}} { get; set; }
{{/each}}
}`,
      );

      const results = await emit(
        `
          namespace Demo;
          model User { id: string; name: string; }
        `,
        { "emit-interfaces": true, templates: { class: tpl } },
      );

      const cls = results["User.g.cs"];
      ok(cls.includes("[Serializable]"), `expected [Serializable] in:\n${cls}`);
      ok(cls.includes("public partial class User : Demo.Models.IUser"));
      ok(cls.includes("public string? Id { get; set; }"));
      ok(cls.includes("public string? Name { get; set; }"));
      ok(results["IUser.g.cs"].includes("public partial interface IUser"));
    });

    it("uses a custom interface template when provided", async () => {
      const tpl = writeTemplate(
        "interface",
        `public partial interface {{interfaceName}}{{baseClause}}
{
{{#each properties}}    {{type}} {{name}} { get; }
{{/each}}
}`,
      );

      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "emit-interfaces": true, templates: { interface: tpl } },
      );

      const iface = results["IUser.g.cs"];
      ok(iface.includes("public partial interface IUser"));
      ok(
        iface.includes("string? Id { get; }"),
        `expected get-only prop in:\n${iface}`,
      );
      ok(
        !iface.includes("set;"),
        `interface should not contain setters in:\n${iface}`,
      );
    });

    it("uses a custom enum template when provided", async () => {
      const tpl = writeTemplate(
        "enum",
        `[Flags]
public enum {{enumName}}
{
{{#each members}}    {{name}}{{#if value}} = {{value}}{{/if}},
{{/each}}
}`,
      );

      const results = await emit(
        `
          namespace Demo;
          enum Color { Red: 1, Green: 2, Blue: 3 }
        `,
        { templates: { enum: tpl } },
      );

      const file = results["Color.g.cs"];
      ok(file.includes("[Flags]"), `expected [Flags] in:\n${file}`);
      ok(file.includes("Red = 1,"));
      ok(file.includes("Blue = 3,"));
    });

    it("uses a custom file template when provided", async () => {
      const tpl = writeTemplate(
        "file",
        `// CUSTOM HEADER
namespace {{namespace}}
{
{{indent body}}
}`,
      );

      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { templates: { file: tpl } },
      );

      const file = results["User.g.cs"];
      ok(
        file.startsWith("// CUSTOM HEADER"),
        `expected custom header in:\n${file}`,
      );
      ok(!file.includes("// <auto-generated/>"));
      ok(file.includes("namespace Demo"));
      ok(file.includes("public partial class User"));
    });

    it("falls back to defaults for templates that are not overridden", async () => {
      const tpl = writeTemplate(
        "class",
        `public sealed class {{className}} : {{bases}}
{
{{indent propertiesBlock}}
}`,
      );

      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "emit-interfaces": true, templates: { class: tpl } },
      );

      ok(results["User.g.cs"].includes("public sealed class User"));
      ok(results["IUser.g.cs"].includes("public partial interface IUser"));
    });
  });

  describe("per-section namespace options", () => {
    it("models-namespace sets verbatim C# namespace for all model files", async () => {
      const results = await emit(`model Free { id: string; }`, {
        "root-namespace": "App",
        "models-namespace": "Acme.Core",
      });

      const file = results["Free.g.cs"];
      ok(file, "expected Free.g.cs");
      ok(
        file.includes("namespace Acme.Core"),
        `expected 'namespace Acme.Core' in:\n${file}`,
      );
    });

    it("interface files always share the models namespace", async () => {
      const results = await emit(`model Free { id: string; }`, {
        "emit-interfaces": true,
        "root-namespace": "App",
        "models-namespace": "Acme.Models",
      });

      const iface = results["IFree.g.cs"];
      ok(iface, "expected IFree.g.cs");
      ok(
        iface.includes("namespace Acme.Models"),
        `expected 'namespace Acme.Models' in:\n${iface}`,
      );
      const cls = results["Free.g.cs"];
      ok(
        cls.includes("namespace Acme.Models"),
        `expected same namespace in class:\n${cls}`,
      );
    });

    it("models and interfaces share the same namespace controlled by models-namespace", async () => {
      const results = await emit(`model Free { id: string; }`, {
        "emit-interfaces": true,
        "root-namespace": "App",
        "models-namespace": "Acme.Shared",
      });

      const file = results["Free.g.cs"];
      ok(
        file.includes("namespace Acme.Shared"),
        `expected 'namespace Acme.Shared' in class:\n${file}`,
      );

      const iface = results["IFree.g.cs"];
      ok(
        iface.includes("namespace Acme.Shared"),
        `expected 'namespace Acme.Shared' in interface:\n${iface}`,
      );
    });
  });

  describe("@serverName decorator", () => {
    it("overrides the emitted class name and file name for a model", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("WidgetResource")
        model Widget { id: string; }
      `);

      ok(
        results["WidgetResource.g.cs"],
        `expected WidgetResource.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        !results["Widget.g.cs"],
        "expected Widget.g.cs NOT to exist after @serverName",
      );
      ok(
        results["WidgetResource.g.cs"].includes("class WidgetResource"),
        "expected class declaration to use server name",
      );
    });

    it("overrides the interface name and file name", async () => {
      const results = await emit(
        `
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("WidgetResource")
        model Widget { id: string; }
      `,
        { "emit-interfaces": true },
      );

      ok(
        results["IWidgetResource.g.cs"],
        "expected IWidgetResource.g.cs to be emitted",
      );
      ok(
        results["IWidgetResource.g.cs"].includes("interface IWidgetResource"),
        "expected interface declaration to use server name",
      );
    });

    it("does not change JsonPropertyName values", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("WidgetResource")
        model Widget { myProp: string; }
      `);

      const file = results["WidgetResource.g.cs"];
      ok(
        file.includes('[JsonPropertyName("myProp")]'),
        "expected JsonPropertyName to retain the original camelCase property name",
      );
    });

    it("is rejected when applied to an enum type", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("WidgetStatus")
        enum Status { Active, Inactive }
      `);

      ok(
        diagnostics.length > 0,
        "expected a diagnostic when @serverName is applied to an enum type",
      );
    });

    it("emits enum file using the TypeSpec name (not renamed)", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        enum Status {
          Active: "active",
          Inactive: "inactive",
        }
      `);

      ok(
        results["Status.g.cs"],
        `expected Status.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        results["Status.g.cs"].includes("enum Status"),
        "expected enum declaration to use TypeSpec name",
      );
      ok(
        results["Status.g.cs"].includes('"active"') &&
          results["Status.g.cs"].includes('"inactive"'),
        "expected EnumMember wire values to be retained",
      );
    });

    it("overrides the C# property name on a model property", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        model Widget {
          @serverName("Identifier")
          id: string;
        }
      `);

      const file = results["Widget.g.cs"];
      ok(
        file.includes("public string? Identifier { get; set; }"),
        "expected property to use server name as C# identifier",
      );
    });

    it("does not change JsonPropertyName when @serverName is applied to a property", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        model Widget {
          @serverName("Identifier")
          id: string;
        }
      `);

      const file = results["Widget.g.cs"];
      ok(
        file.includes('[JsonPropertyName("id")]'),
        "expected JsonPropertyName to retain the original camelCase property name",
      );
    });

    it("is rejected when applied to an enum member", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        enum Status {
          @serverName("Running")
          active: "active",
        }
      `);

      ok(
        diagnostics.length > 0,
        "expected a diagnostic when @serverName is applied to an enum member",
      );
    });

    it("falls back to TypeSpec name when @serverName is not applied", async () => {
      const results = await emit(
        `namespace Demo; model Widget { id: string; }`,
      );
      ok(results["Widget.g.cs"], "expected Widget.g.cs when no @serverName");
      ok(
        results["Widget.g.cs"].includes("class Widget"),
        "expected class to use TypeSpec name",
      );
    });

    it("reports a diagnostic for an invalid C# identifier", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("invalid name!")
        model Widget { id: string; }
      `);

      ok(
        diagnostics.some((d) => d.code.includes("invalid-server-name")),
        "expected invalid-server-name diagnostic for a name with spaces and punctuation",
      );
    });

    it("reports a diagnostic for a name with path separators", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("../../EvilFile")
        model Widget { id: string; }
      `);

      ok(
        diagnostics.some((d) => d.code.includes("invalid-server-name")),
        "expected invalid-server-name diagnostic for a name with path separators",
      );
    });

    it("reports a diagnostic for a name that starts with a digit", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("123Widget")
        model Widget { id: string; }
      `);

      ok(
        diagnostics.some((d) => d.code.includes("invalid-server-name")),
        "expected invalid-server-name diagnostic for a name starting with a digit",
      );
    });

    it("reports a diagnostic for a C# reserved keyword without @", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("class")
        model Widget { id: string; }
      `);

      ok(
        diagnostics.some((d) => d.code.includes("invalid-server-name")),
        "expected invalid-server-name diagnostic for a bare C# reserved keyword",
      );
    });

    it("accepts a name with a leading @ (C# verbatim identifier)", async () => {
      const results = await emit(
        `
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("@class")
        model Widget { id: string; }
      `,
        { "emit-interfaces": true },
      );

      ok(
        results["@class.g.cs"],
        "expected @class.g.cs to be emitted for a verbatim identifier",
      );
      ok(
        results["Iclass.g.cs"],
        "expected Iclass.g.cs to match interface type name for a verbatim identifier",
      );
      ok(
        !results["I@class.g.cs"],
        "expected I@class.g.cs not to be emitted for a verbatim identifier",
      );
    });

    it("uses @serverName on a base model when generating the base class reference", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("EntityBase")
        model Base { id: string; }
        model Widget extends Base { name: string; }
      `);

      const file = results["Widget.g.cs"];
      ok(
        file.includes(": Models.EntityBase"),
        "expected base class reference to use @serverName",
      );
      ok(
        !file.includes(": Base"),
        "expected original TypeSpec base name not to appear as base class",
      );
    });

    it("uses @serverName on a model referenced as a property type", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("TagResource")
        model Tag { label: string; }
        model Widget { tag: Tag; }
      `);

      const file = results["Widget.g.cs"];
      ok(
        file.includes("TagResource?"),
        "expected property type to use @serverName on the referenced model",
      );
      ok(
        !file.includes("Tag?"),
        "expected original TypeSpec model name not to appear as property type",
      );
    });

    it("uses @serverName on a model in an array property type", async () => {
      const results = await emit(`
        import "@massivescale/tsp-aspnetcore-api";
        using MassiveScale.AspNetCoreApi;

        namespace Demo;
        @serverName("TagResource")
        model Tag { label: string; }
        model Widget { tags: Tag[]; }
      `);

      const file = results["Widget.g.cs"];
      ok(
        file.includes("IList<Models.TagResource>?"),
        "expected array element type to use @serverName",
      );
    });
  });
});
