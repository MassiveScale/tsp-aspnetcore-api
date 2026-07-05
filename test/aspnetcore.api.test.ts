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

describe("csharp emitter", () => {
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

    it("does not emit a separate class for MergePatchUpdate models, emits MergePatch helper", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        namespace Demo;

        model Widget {
          id: string;
          weight: int32;
        }

        model WidgetMergePatchUpdate is MergePatchUpdate<Widget>;
      `);

      ok(
        !results["WidgetMergePatchUpdate.g.cs"] &&
          !results["Models/WidgetMergePatchUpdate.g.cs"],
        "MergePatch model should not produce a separate class file",
      );

      ok(
        results["Widget.g.cs"] ?? results["Models/Widget.g.cs"],
        "expected Widget.g.cs",
      );

      const helper = results["Helpers/MergePatch.g.cs"];
      ok(helper, "expected Helpers/MergePatch.g.cs");
      ok(helper.includes("IsDefined"), `expected IsDefined in:\n${helper}`);
      ok(helper.includes("IsNull"), `expected IsNull in:\n${helper}`);
      ok(helper.includes("GetString"), `expected GetString in:\n${helper}`);
      ok(helper.includes("TryGetValue"), `expected TryGetValue in:\n${helper}`);
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
        widget.includes("public WidgetColor? Color { get; set; }"),
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
        ctrl.includes("MergePatch<Widget>"),
        `expected MergePatch<Widget> in PATCH body in:\n${ctrl}`,
      );
      ok(
        !ctrl.includes("WidgetPatch"),
        "expected MergePatchUpdate model to be replaced with MergePatch<Widget>",
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
      ok(dog.includes("public partial class Dog : Animal"));
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
        file.includes("public Size? Size { get; set; } = Size.Medium;"),
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
      ok(file.includes("public A? Ref { get; set; }"));
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
      ok(file.includes("public Address? Home { get; set; }"));
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
      ok(file.includes("public IList<Tag>? Tags { get; set; }"));
      ok(
        file.includes(
          "public IDictionary<string, Tag>? ScoresByTag { get; set; }",
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
      ok(file.includes("public partial class User : Entity"));
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
      ok(file.includes("public Address? Home { get; set; }"));
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
      ok(file.includes("public Address? Home { get; set; }"));
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

      ok(cls.includes("public partial class User : IUser"));
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

      ok(dogClass.includes("public partial class Dog : Animal, IDog"));
      ok(dogIface.includes("public partial interface IDog : IAnimal"));
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
      ok(cls.includes("public partial class User : IUser"));
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

    it("reports a diagnostic when a custom template cannot be loaded", async () => {
      const [, diagnostics] = await emitWithDiagnostics(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { templates: { class: "/no/such/file/class.hbs" } },
      );

      const failure = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-aspnetcore-api/template-load-failed",
      );
      ok(
        failure,
        `expected template-load-failed diagnostic, got: ${JSON.stringify(diagnostics)}`,
      );
      ok(
        failure.message.includes("class"),
        `diagnostic should name template: ${failure.message}`,
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

    it("adds CancellationToken parameter by default (cancellation-token defaults to true)", async () => {
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

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service interface");
      ok(
        svc.includes("using System.Threading;"),
        `missing 'using System.Threading;' in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task<IList<Item>?> ListAsync(CancellationToken cancellationToken);",
        ),
        `missing ListAsync in service:\n${svc}`,
      );
    });

    it("adds CancellationToken parameter when cancellation-token is true", async () => {
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
          "public abstract Task<IActionResult> Create([FromBody] Item body, CancellationToken cancellationToken);",
        ),
        `missing Create in controller:\n${ctrl}`,
      );

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service interface");
      ok(
        svc.includes("using System.Threading;"),
        `missing 'using System.Threading;' in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task<IList<Item>?> ListAsync(CancellationToken cancellationToken);",
        ),
        `missing ListAsync in service:\n${svc}`,
      );
      ok(
        svc.includes(
          "Task CreateAsync(Item body, CancellationToken cancellationToken);",
        ),
        `missing CreateAsync in service:\n${svc}`,
      );
    });

    it("omits CancellationToken parameter when cancellation-token is false", async () => {
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
    it("emits a controller and service interface pair for an HTTP interface", async () => {
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
      ok(
        results["Services/IUsersService.g.cs"],
        "expected Services/IUsersService.g.cs",
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

    it("controller is abstract and the service interface file is emitted", async () => {
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

      const svc = results["Services/IOrdersService.g.cs"];
      ok(svc, `expected Services/IOrdersService.g.cs`);
      ok(
        svc.includes("public partial interface IOrdersService"),
        `expected interface decl in:\n${svc}`,
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
        svc.includes("Task<IList<Widget>?>"),
        `expected IList<Widget> return in:\n${svc}`,
      );
      ok(svc.includes("Task<Widget?>"), `expected Widget return in:\n${svc}`);
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
        svc.includes("Task<Widget?>"),
        `expected Task<Widget?> for @body response in:\n${svc}`,
      );
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

    it("routes controllers and services to separate dirs when configured", async () => {
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
      ok(
        results["Services/ITasksService.g.cs"],
        "expected Services/ITasksService.g.cs",
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

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service file");
      ok(
        svc.includes("namespace Demo.Services"),
        `expected 'namespace Demo.Services' in:\n${svc}`,
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

  describe("helpers generation", () => {
    it("infers helper namespace from the TypeSpec namespace when root-namespace is not set", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M { x: int32; }
      `,
        { "emit-helpers": true },
      );

      const helper = results["Helpers/EnumMemberConverter.g.cs"];
      ok(
        helper,
        `expected Helpers/EnumMemberConverter.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        helper.includes("namespace Demo.Helpers"),
        `expected 'namespace Demo.Helpers' in:\n${helper}`,
      );
    });

    it("uses explicit root-namespace for helpers when provided", async () => {
      const results = await emit(
        `
        namespace Demo;
        model M { x: int32; }
      `,
        { "emit-helpers": true, "root-namespace": "MyApp" },
      );

      const helper = results["Helpers/EnumMemberConverter.g.cs"];
      ok(helper, `expected Helpers/EnumMemberConverter.g.cs`);
      ok(
        helper.includes("namespace MyApp.Helpers"),
        `expected 'namespace MyApp.Helpers' in:\n${helper}`,
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

    it("emits a WidgetMergePatchUpdate.g.cs file in the models directory", async () => {
      const results = await emit(TYPED_SPEC, { "merge-patch-style": "typed" });

      const file =
        results["WidgetMergePatchUpdate.g.cs"] ??
        results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(
        file,
        `expected WidgetMergePatchUpdate.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
    });

    it("does not emit the generic MergePatch.g.cs helper", async () => {
      const results = await emit(TYPED_SPEC, { "merge-patch-style": "typed" });

      ok(
        !results["Helpers/MergePatch.g.cs"],
        "typed style must not emit generic MergePatch.g.cs",
      );
    });

    it("generated class is named WidgetMergePatchUpdate", async () => {
      const results = await emit(TYPED_SPEC, { "merge-patch-style": "typed" });

      const file =
        results["WidgetMergePatchUpdate.g.cs"] ??
        results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(file, "expected WidgetMergePatchUpdate.g.cs");
      ok(
        file.includes("public class WidgetMergePatchUpdate"),
        `expected 'public class WidgetMergePatchUpdate' in:\n${file}`,
      );
    });

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

    it("exposes IsDefined, IsNull, Patch, and PatchAsync on the typed class", async () => {
      const results = await emit(TYPED_SPEC, { "merge-patch-style": "typed" });

      const file =
        results["WidgetMergePatchUpdate.g.cs"] ??
        results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(file, "expected WidgetMergePatchUpdate.g.cs");
      ok(file.includes("IsDefined"), `expected IsDefined in:\n${file}`);
      ok(file.includes("IsNull"), `expected IsNull in:\n${file}`);
      ok(
        file.includes("public void Patch(Demo.Models.Widget"),
        `expected Patch method in:\n${file}`,
      );
      ok(
        file.includes("public ValueTask PatchAsync(Demo.Models.Widget"),
        `expected PatchAsync method in:\n${file}`,
      );
    });

    it("colocates the typed file with the model when root-namespace is set", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{ title: "API" })
        namespace Demo.Api.V1;

        model Widget { id: string; name: string; }
        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
      `,
        { "merge-patch-style": "typed", "root-namespace": "Demo" },
      );

      const file = results["Models/Api/V1/WidgetMergePatchUpdate.g.cs"];
      ok(
        file,
        `expected Models/Api/V1/WidgetMergePatchUpdate.g.cs alongside Widget.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
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

    it("validators-namespace sets verbatim C# namespace for all validator files", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Widget { name: string; }

        @route("/widgets")
        interface Widgets {
          @post create(@body widget: Widget): Widget;
        }
      `,
        {
          "root-namespace": "Demo",
          "validators-namespace": "MyCompany.Validators",
          "emit-validators": true,
        },
      );

      const validator = results["Validators/WidgetValidator.g.cs"];
      ok(
        validator,
        `expected Validators/WidgetValidator.g.cs, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        validator.includes("namespace MyCompany.Validators"),
        `expected 'namespace MyCompany.Validators' in:\n${validator}`,
      );
    });

    it("per-section overrides are independent — unset sections default to root-namespace.Section", async () => {
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

      // controller uses the verbatim override
      const ctrl = results["Controllers/ItemsControllerBase.g.cs"];
      ok(
        ctrl.includes("namespace MyCompany.Web"),
        `expected override ns in ctrl:\n${ctrl}`,
      );

      // service defaults to root-namespace.Services
      const svc = results["Services/IItemsService.g.cs"];
      ok(
        svc.includes("namespace App.Services"),
        `expected default ns in svc:\n${svc}`,
      );
    });
  });

  // ── @serverName decorator ───────────────────────────────────────────────────

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

    it("uses @serverName in controller and service method signatures", async () => {
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
        ctrl.includes("[FromBody] PetResource body"),
        "expected controller body parameter type to use @serverName",
      );
      ok(
        !ctrl.includes("[FromBody] Pet body"),
        "expected controller not to use raw TypeSpec model name in body parameter",
      );

      const svc =
        results["Services/IPetsService.g.cs"] ??
        results[
          Object.keys(results).find((k) => k.endsWith("IPetsService.g.cs"))!
        ];
      ok(svc, "expected service interface file to be emitted");
      ok(
        svc.includes("Task<PetResource?> CreateAsync(PetResource body"),
        "expected service method signature to use @serverName for parameter and return type",
      );
      ok(
        !svc.includes("Task<Pet?> CreateAsync(Pet body"),
        "expected service signature not to use raw TypeSpec model name",
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
        file.includes(": EntityBase"),
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
        file.includes("IList<TagResource>?"),
        "expected array element type to use @serverName",
      );
    });

    it("uses @serverName for the validator referenced model and param names", async () => {
      const [results] = await emitWithDiagnostics(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using TypeSpec.Http;

        namespace Demo;
        @serverName("AuthorResource")
        model Author { name: string; }
        model Book { author: Author; }

        @route("/books")
        interface Books {
          @post create(@body body: Book): Book;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );

      const validatorFile = results["Validators/BookValidator.g.cs"];
      ok(validatorFile, "expected BookValidator.g.cs to be emitted");
      ok(
        validatorFile.includes("AuthorResource"),
        "expected validator to reference the renamed model 'AuthorResource'",
      );
      ok(
        !validatorFile.includes("authorValidator"),
        "expected validator not to use the raw TypeSpec name as param",
      );
      ok(
        validatorFile.includes("authorResourceValidator"),
        "expected validator param to be derived from the server name",
      );
    });

    it("derives the plain (non-MergePatch) PATCH body type name from @serverName", async () => {
      const tpl = writeTemplate(
        "validator-patch",
        `patchBodyTypeName={{{patchBodyTypeName}}}`,
      );

      const [results] = await emitWithDiagnostics(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using TypeSpec.Http;

        @service(#{ title: "Widgets" })
        namespace Demo;

        @serverName("WidgetResource")
        model Widget { id: string; name: string; }

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: Widget): Widget;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
          templates: { "validator-patch": tpl },
        },
      );

      const validatorFile =
        results["Validators/WidgetResourcePatchValidator.g.cs"];
      ok(
        validatorFile,
        `expected WidgetResourcePatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      strictEqual(validatorFile, "patchBodyTypeName=WidgetResource");
    });
  });

  describe("ValidatorsInitializer", () => {
    it("uses a fully-qualified MergePatch<T> type in registrations", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Widget { name: string; }
        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
      `,
        {
          "root-namespace": "Demo",
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
        },
      );

      const file = results["Validators/ValidatorsInitializer.g.cs"];
      ok(
        file,
        `expected Validators/ValidatorsInitializer.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        file.includes("Demo.Helpers.MergePatch<Demo.Models.Widget>"),
        `expected fully-qualified MergePatch<T> in:\n${file}`,
      );
      ok(
        !file.includes("MergePatch<Demo.Models.Widget>") ||
          file.includes("Demo.Helpers.MergePatch<Demo.Models.Widget>"),
        "unqualified MergePatch<T> must not appear without namespace prefix",
      );
    });
  });
});
