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
      const nonHelperKeys = Object.keys(results).filter((k) => !k.startsWith("Helpers/"));
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
    it("strips root namespace from folder paths", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        { "root-namespace": "App" },
      );

      const file = results["Models/User.g.cs"];
      ok(file, `expected Models/User.cs, got ${Object.keys(results).join(", ")}`);
      ok(file.includes("namespace App.Users.Models"));
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

    it("places models outside the root namespace at the output root, keeping their namespace", async () => {
      const results = await emit(
        `
          namespace Other.Stuff;
          model Foreign { id: string; }
        `,
        { "root-namespace": "App" },
      );

      const file = results["Foreign.g.cs"];
      ok(file, "expected Foreign.cs at root");
      ok(file.includes("namespace Other.Stuff"));
    });

    it("supports nested root namespace prefixes", async () => {
      const results = await emit(
        `
          namespace App.Api.V1.Users;
          model User { id: string; }
        `,
        { "root-namespace": "App.Api" },
      );

      const file = results["Models/User.g.cs"];
      ok(file, `expected Models/User.cs, got ${Object.keys(results).join(", ")}`);
      ok(file.includes("namespace App.Api.V1.Users.Models"));
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
      ok(file.includes("public IDictionary<string, int>? Scores { get; set; }"));
    });

    it("emits MergePatchUpdate properties as MergePatchValue wrappers", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        namespace Demo;

        model Widget {
          id: string;
          weight: int32;
          color: string | null;
        }

        model WidgetMergePatchUpdate is MergePatchUpdate<Widget>;
      `);

      const file =
        results["WidgetMergePatchUpdate.g.cs"] ??
        results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(file, `expected WidgetMergePatchUpdate.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(file.includes("using Demo.Helpers;"), `expected helper namespace using in:\n${file}`);
      ok(file.includes("public MergePatchValue<string?> Id { get; set; } = MergePatchValue<string?>.Absent;"), `expected wrapped id property in:\n${file}`);
      ok(file.includes("public MergePatchValue<int?> Weight { get; set; } = MergePatchValue<int?>.Absent;"), `expected wrapped weight property in:\n${file}`);
      ok(file.includes("public MergePatchValue<string?> Color { get; set; } = MergePatchValue<string?>.Absent;"), `expected wrapped color property in:\n${file}`);

      const iface =
        results["IWidgetMergePatchUpdate.g.cs"] ??
        results["Interfaces/IWidgetMergePatchUpdate.g.cs"];
      ok(iface, `expected IWidgetMergePatchUpdate.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(iface.includes("using Demo.Helpers;"), `expected helper namespace using in interface:\n${iface}`);
      ok(iface.includes("MergePatchValue<string?> Id { get; set; }"), `expected wrapped id in interface:\n${iface}`);

      const helper = results["Helpers/MergePatchValue.g.cs"];
      ok(helper, "expected MergePatchValue helper when MergePatchUpdate model is emitted");
    });

    it("resolves inferred enum types in versioned models and merge patch models", async () => {
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

        model WidgetMergePatchUpdate is MergePatchUpdate<Widget>;
      `);

      const widget = results["Models/Widget.g.cs"];
      ok(widget, `expected Models/Widget.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(widget.includes("public WidgetColor? Color { get; set; }"), `expected WidgetColor in:\n${widget}`);
      ok(!widget.includes("public object? Color { get; set; }"), `did not expect object for Color in:\n${widget}`);

      const mergePatch = results["Models/WidgetMergePatchUpdate.g.cs"];
      ok(mergePatch, `expected Models/WidgetMergePatchUpdate.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(
        mergePatch.includes("public MergePatchValue<WidgetColor?> Color { get; set; } = MergePatchValue<WidgetColor?>.Absent;"),
        `expected MergePatchValue<WidgetColor?> in:\n${mergePatch}`,
      );
      ok(
        !mergePatch.includes("public MergePatchValue<object?> Color { get; set; } = MergePatchValue<object?>.Absent;"),
        `did not expect MergePatchValue<object?> in:\n${mergePatch}`,
      );

      const inferredEnum = results["Models/WidgetColor.g.cs"];
      ok(inferredEnum, `expected inferred enum Models/WidgetColor.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(inferredEnum.includes("public enum WidgetColor"), `expected WidgetColor enum in:\n${inferredEnum}`);
      ok(inferredEnum.includes('EnumMember(Value = "red")'), `expected red member value in:\n${inferredEnum}`);
      ok(inferredEnum.includes('EnumMember(Value = "blue")'), `expected blue member value in:\n${inferredEnum}`);
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
      const results = await emit(`
        namespace Demo;
        model X { v: string; }
      `);
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

      const file = results["Pagination.g.cs"] ?? results["Models/Pagination.g.cs"];
      ok(file, `expected Pagination.g.cs, got ${Object.keys(results).join(", ")}`);
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

    it("adds a using for a referenced type in another namespace", async () => {
      const results = await emit(`
        namespace App.Common { model Address { city: string; } }
        namespace App.Users { model User { home: App.Common.Address; } }
      `);
      const file = results["User.g.cs"];
      ok(file.includes("namespace App.Users.Models"));
      ok(file.includes("using App.Common.Models;"), `expected using App.Common.Models; in:\n${file}`);
      ok(file.includes("public Address? Home { get; set; }"));
    });

    it("adds usings for referenced array element and record value types", async () => {
      const results = await emit(`
        namespace App.Common { model Tag { name: string; } }
        namespace App.Users {
          model User {
            tags: App.Common.Tag[];
            scoresByTag: Record<App.Common.Tag>;
          }
        }
      `);
      const file = results["User.g.cs"];
      ok(file.includes("using App.Common.Models;"));
      ok(file.includes("public IList<Tag>? Tags { get; set; }"));
      ok(file.includes("public IDictionary<string, Tag>? ScoresByTag { get; set; }"));
    });

    it("adds a using for a base model in another namespace", async () => {
      const results = await emit(`
        namespace App.Base { model Entity { id: string; } }
        namespace App.Users { model User extends App.Base.Entity { name: string; } }
      `);
      const file = results["User.g.cs"];
      ok(file.includes("using App.Base.Models;"));
      ok(file.includes("public partial class User : Entity"));
    });
  });

  describe("namespace-map option", () => {
    it("rewrites the C# namespace for a model in a mapped namespace", async () => {
      const results = await emit(
        `
          namespace Foo.Bar;
          model Widget { id: string; }
        `,
        { "namespace-map": { "Foo.Bar": "Acme.Things" } },
      );
      const file = results["Widget.g.cs"];
      ok(file, `expected Widget.cs, got ${Object.keys(results).join(", ")}`);
      ok(file.includes("namespace Acme.Things"), `wrong namespace in:\n${file}`);
    });

    it("applies the mapping as a prefix replacement to nested namespaces", async () => {
      const results = await emit(
        `
          namespace Foo.Bar.Sub;
          model Widget { id: string; }
        `,
        { "namespace-map": { "Foo.Bar": "Acme.Things" } },
      );
      const file = results["Widget.g.cs"];
      ok(file.includes("namespace Acme.Things.Sub"), `wrong namespace in:\n${file}`);
    });

    it("uses the longest matching key when multiple mappings could apply", async () => {
      const results = await emit(
        `
          namespace Foo.Bar.Sub;
          model Widget { id: string; }
        `,
        {
          "namespace-map": {
            Foo: "Acme",
            "Foo.Bar": "Acme.Things",
          },
        },
      );
      const file = results["Widget.g.cs"];
      ok(file.includes("namespace Acme.Things.Sub"));
    });

    it("emits using statements that reflect the mapped namespace of referenced types", async () => {
      const results = await emit(
        `
          namespace Legacy.Common { model Address { city: string; } }
          namespace App.Users { model User { home: Legacy.Common.Address; } }
        `,
        { "namespace-map": { "Legacy.Common": "Acme.Common" } },
      );
      const file = results["User.g.cs"];
      ok(file.includes("namespace App.Users.Models"));
      ok(
        file.includes("using Acme.Common.Models;"),
        `expected mapped using Acme.Common.Models; in:\n${file}`,
      );
      ok(!file.includes("using Legacy.Common.Models;"));
      ok(file.includes("public Address? Home { get; set; }"));
    });

    it("places mapped models in folders that match the mapped C# namespace under the root", async () => {
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
      const file = results["Models/Address.g.cs"];
      ok(file, `expected Models/Address.cs, got ${Object.keys(results).join(", ")}`);
      ok(file.includes("namespace Acme.Common.Models"));
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
      ok(!file.includes("using App.Users;"), `unexpected self-using in:\n${file}`);
      ok(file.includes("public Address? Home { get; set; }"));
    });
  });

  describe("interface generation", () => {
    it("emits a corresponding I<Model> interface alongside each class", async () => {
      const results = await emit(`
        namespace Demo;
        model User { id: string; name: string; }
      `);

      const cls = results["User.g.cs"];
      const iface = results["IUser.g.cs"];
      ok(cls, "expected User.g.cs");
      ok(iface, "expected IUser.g.cs");

      ok(cls.includes("public partial class User : IUser"));
      ok(cls.includes("public string? Id { get; set; }"));

      ok(iface.includes("public partial interface IUser"));
      ok(iface.includes("string? Id { get; set; }"));
      ok(iface.includes("string? Name { get; set; }"));
      ok(!iface.includes("public string"), "interface members should not have access modifiers");
    });

    it("includes the interface alongside the base class on extends", async () => {
      const results = await emit(`
        namespace Demo;
        model Animal { name: string; }
        model Dog extends Animal { breed: string; }
      `);

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
      const results = await emit(`
        namespace Demo;
        model M { @format("uuid") id?: string; nick?: string; }
      `);
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
        { "models-output-dir": "models" },
      );

      ok(results["models/User.g.cs"], `expected models/User.cs, got ${Object.keys(results).join(", ")}`);
      ok(results["Models/IUser.g.cs"], "interface should still be at default Models output dir");
      ok(!results["User.g.cs"], "class should not be at default location when override is set");
    });

    it("routes interface files into interfaces-output-dir", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        { "interfaces-output-dir": "interfaces" },
      );

      ok(results["User.g.cs"], "class should still be at default emitter-output-dir");
      ok(results["interfaces/IUser.g.cs"]);
      ok(!results["IUser.g.cs"], "interface should not be at default location when override is set");
    });

    it("routes both when both overrides are provided", async () => {
      const results = await emit(
        `
          namespace Demo;
          model User { id: string; }
        `,
        {
          "models-output-dir": "src/models",
          "interfaces-output-dir": "src/interfaces",
        },
      );

      ok(results["src/models/User.g.cs"]);
      ok(results["src/interfaces/IUser.g.cs"]);
    });

    it("appends output-dir segments to TypeSpec namespace when namespace-from-path is enabled (default)", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        {
          "root-namespace": "App",
          "models-output-dir": "models",
          "interfaces-output-dir": "interfaces",
        },
      );

      // Files are flat under each output dir; the dir segment is appended to
      // the TypeSpec namespace.
      ok(results["models/User.g.cs"], `expected flat models/User.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(results["interfaces/IUser.g.cs"], "expected flat interfaces/IUser.g.cs");
      ok(results["models/User.g.cs"].includes("namespace App.Users.Models"));
      ok(results["interfaces/IUser.g.cs"].includes("namespace App.Users.Interfaces"));
    });

    it("uses subfolder layout (not dir-suffix) when namespace-from-path is disabled", async () => {
      const results = await emit(
        `
          namespace App.Users;
          model User { id: string; }
        `,
        {
          "root-namespace": "App",
          "models-output-dir": "models",
          "interfaces-output-dir": "interfaces",
          "namespace-from-path": false,
        },
      );

      ok(results["models/Users/User.g.cs"], `expected models/Users/User.g.cs, got ${Object.keys(results).join(", ")}`);
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
        { "additional-usings": ["System.Text.Json", "Newtonsoft.Json"] },
      );

      for (const key of ["User.g.cs", "IUser.g.cs", "Color.g.cs"]) {
        const file = results[key];
        ok(file, `expected ${key}`);
        ok(file.includes("using System.Text.Json;"), `missing System.Text.Json in ${key}`);
        ok(file.includes("using Newtonsoft.Json;"), `missing Newtonsoft.Json in ${key}`);
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
      ok(sysJsonIdx < newtonIdx, "System.Text.Json should come before Newtonsoft");
    });

    it("does not duplicate a using already implied by a cross-namespace reference", async () => {
      const results = await emit(
        `
          namespace App.Common { model Address { city: string; } }
          namespace App.Users { model User { home: App.Common.Address; } }
        `,
        { "additional-usings": ["App.Common"] },
      );
      const file = results["User.g.cs"];
      const occurrences = file.split("using App.Common;").length - 1;
      strictEqual(occurrences, 1, `expected exactly one 'using App.Common;' in:\n${file}`);
    });
  });

  describe("nullable-properties option", () => {
    it("renders all properties as nullable by default", async () => {
      const results = await emit(`
        namespace Demo;
        model M {
          name: string;
          age: int32;
          tags: string[];
        }
      `);
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
        { "nullable-properties": false },
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
      ok(cls.includes('[JsonPropertyName("firstName")]'), `missing firstName attr in:\n${cls}`);
      ok(cls.includes('[JsonPropertyName("userId")]'), `missing userId attr in:\n${cls}`);
    });

    it("converts snake_case property names to camelCase JSON keys", async () => {
      const results = await emit(`
        namespace Demo;
        model M { first_name: string; user_id: string; }
      `);
      const cls = results["M.g.cs"];
      ok(cls.includes('[JsonPropertyName("firstName")]'), `missing firstName attr in:\n${cls}`);
      ok(cls.includes('[JsonPropertyName("userId")]'), `missing userId attr in:\n${cls}`);
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
      ok(cls.includes('[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]'), `missing JsonIgnore in:\n${cls}`);
      // Count occurrences: only the nullable optional property should have it
      const count = (cls.match(/\[JsonIgnore\(/g) ?? []).length;
      strictEqual(count, 1, `expected 1 JsonIgnore, got ${count} in:\n${cls}`);
    });

    it("adds [JsonPropertyName] and [JsonIgnore] to interface properties", async () => {
      const results = await emit(`
        namespace Demo;
        model M { name: string; }
      `);
      const iface = results["IM.g.cs"];
      ok(iface.includes('[JsonPropertyName("name")]'), `missing JsonPropertyName in:\n${iface}`);
      ok(iface.includes('[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]'), `missing JsonIgnore in:\n${iface}`);
    });

    it("adds [JsonConverter(typeof(EnumMemberConverterFactory))] to enums", async () => {
      const results = await emit(`
        namespace Demo;
        enum Color { Red, Green, Blue }
      `);
      const file = results["Color.g.cs"];
      ok(file.includes("[JsonConverter(typeof(EnumMemberConverterFactory))]"), `missing converter in:\n${file}`);
    });

    it("includes using System.Text.Json.Serialization in model files", async () => {
      const results = await emit(`
        namespace Demo;
        model M { id: string; }
        enum Status { Active, Inactive }
      `);
      ok(results["M.g.cs"].includes("using System.Text.Json.Serialization;"));
      ok(results["IM.g.cs"].includes("using System.Text.Json.Serialization;"));
      ok(results["Status.g.cs"].includes("using System.Text.Json.Serialization;"));
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
        { templates: { class: tpl } },
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
        { templates: { interface: tpl } },
      );

      const iface = results["IUser.g.cs"];
      ok(iface.includes("public partial interface IUser"));
      ok(iface.includes("string? Id { get; }"), `expected get-only prop in:\n${iface}`);
      ok(!iface.includes("set;"), `interface should not contain setters in:\n${iface}`);
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
      ok(file.startsWith("// CUSTOM HEADER"), `expected custom header in:\n${file}`);
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
        { templates: { class: tpl } },
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
        (d) => d.code === "@massivescale/tsp-aspnetcore-api/template-load-failed",
      );
      ok(failure, `expected template-load-failed diagnostic, got: ${JSON.stringify(diagnostics)}`);
      ok(failure.message.includes("class"), `diagnostic should name template: ${failure.message}`);
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

      ok(results["Controllers/UsersControllerBase.g.cs"], "expected Controllers/UsersControllerBase.g.cs");
      ok(results["Services/IUsersService.g.cs"], "expected Services/IUsersService.g.cs");
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(!ctrl.includes("[Route("), `class-level [Route] should not be present:\n${ctrl}`);
      ok(ctrl.includes('[HttpGet("/api/items")]'), `expected method-level route in:\n${ctrl}`);
      ok(ctrl.includes("[ApiController]"), `expected [ApiController] in:\n${ctrl}`);
      ok(ctrl.includes("ControllerBase"), `expected ControllerBase in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes("public abstract class OrdersControllerBase"), `expected abstract class in:\n${ctrl}`);

      const svc = results["Services/IOrdersService.g.cs"];
      ok(svc, `expected Services/IOrdersService.g.cs`);
      ok(svc.includes("public interface IOrdersService"), `expected interface decl in:\n${svc}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes('[HttpGet("/api/things")]'), `expected root HttpGet in:\n${ctrl}`);
      ok(ctrl.includes('[HttpPost("/api/things")]'), `expected HttpPost in:\n${ctrl}`);
      ok(ctrl.includes('[HttpGet("/api/things/{id}")]'), `expected HttpGet with id in:\n${ctrl}`);
      ok(ctrl.includes('[HttpPut("/api/things/{id}")]'), `expected HttpPut in:\n${ctrl}`);
      ok(ctrl.includes('[HttpDelete("/api/things/{id}")]'), `expected HttpDelete in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes("[FromQuery]"), `expected [FromQuery] in:\n${ctrl}`);
      ok(ctrl.includes("[FromRoute]"), `expected [FromRoute] in:\n${ctrl}`);
      ok(ctrl.includes("string q"), `expected q param in:\n${ctrl}`);
      ok(ctrl.includes("int? page"), `expected optional page param in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
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
      ok(svc, `expected Services/IUsersService.g.cs, got ${Object.keys(results).join(", ")}`);
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
      ok(svc.includes("public interface IUsersService"), `expected interface decl in:\n${svc}`);
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
      ok(svc.includes("Task RemoveAsync("), `expected plain Task for void response in:\n${svc}`);
      ok(svc.includes("Task ReplaceAsync("), `expected plain Task for 204 response in:\n${svc}`);
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
      ok(svc.includes("Task<IList<Widget>?>"), `expected IList<Widget> return in:\n${svc}`);
      ok(svc.includes("Task<Widget?>"), `expected Widget return in:\n${svc}`);
      ok(svc.includes("Task RemoveAsync("), `expected plain Task for void|error response in:\n${svc}`);
      ok(!svc.includes("ApiError"), `did not expect ApiError in service interface:\n${svc}`);
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
      ok(svc.includes("Task<Widget?>"), `expected Task<Widget?> for @body response in:\n${svc}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(!ctrl.includes("[Route("), `class-level [Route] should not be present:\n${ctrl}`);
      ok(ctrl.includes("v1"), `expected v1 route in:\n${ctrl}`);
      ok(ctrl.includes("v2"), `expected v2 route in:\n${ctrl}`);
      // list() has one [HttpGet] per version
      const verbCount = (ctrl.match(/\[HttpGet\(/g) ?? []).length;
      strictEqual(verbCount, 2, `expected 2 [HttpGet] attributes, got ${verbCount} in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes('[HttpGet("/api/v1/widgets/{id}")]'), `expected v1 id route in:\n${ctrl}`);
      ok(ctrl.includes('[HttpGet("/api/v2/widgets/{id}")]'), `expected v2 id route in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);

      ok(ctrl.includes('[HttpGet("/api/v2/widgets/{id}/audit")]'), `expected v2 audit route in:\n${ctrl}`);
      ok(ctrl.includes('[HttpGet("/api/v3/widgets/{id}/audit")]'), `expected v3 audit route in:\n${ctrl}`);
      ok(!ctrl.includes('[HttpGet("/api/v1/widgets/{id}/audit")]'), `did not expect v1 audit route in:\n${ctrl}`);

      ok(ctrl.includes('[HttpGet("/api/v1/widgets/{id}/legacy")]'), `expected v1 legacy route in:\n${ctrl}`);
      ok(ctrl.includes('[HttpGet("/api/v2/widgets/{id}/legacy")]'), `expected v2 legacy route in:\n${ctrl}`);
      ok(!ctrl.includes('[HttpGet("/api/v3/widgets/{id}/legacy")]'), `did not expect v3 legacy route in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(!ctrl.includes('[HttpPost("/api/1.0/widgets")]'), `did not expect v1.0 create route in:\n${ctrl}`);
      ok(ctrl.includes('[HttpPost("/api/1.1/widgets")]'), `expected v1.1 create route in:\n${ctrl}`);
      ok(ctrl.includes('[HttpPost("/api/2.0/widgets")]'), `expected v2.0 create route in:\n${ctrl}`);
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes("v2/api/items"), `expected v2/api/items route in:\n${ctrl}`);
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

      ok(results["Controllers/TasksControllerBase.g.cs"], `expected Controllers/TasksControllerBase.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(results["Services/ITasksService.g.cs"], "expected Services/ITasksService.g.cs");
    });

    it("infers controller namespace from the TypeSpec namespace when root-namespace is not set", async () => {
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
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes("namespace Demo.Controllers"), `expected 'namespace Demo.Controllers' in:\n${ctrl}`);

      const svc = results["Services/IItemsService.g.cs"];
      ok(svc, "expected service file");
      ok(svc.includes("namespace Demo.Services"), `expected 'namespace Demo.Services' in:\n${svc}`);
    });

    it("infers a multi-segment controller namespace when the TypeSpec namespace is multi-segment", async () => {
      const results = await emit(`
        import "@typespec/http";
        using TypeSpec.Http;

        @service(#{title: "Orders" })
        namespace My.Company.Orders;

        model Order { id: string; }

        @route("/orders")
        interface Orders {
          @get list(): Order[];
        }
      `);

      const ctrl = results["Controllers/OrdersControllerBase.g.cs"];
      ok(ctrl, `expected controller file, got ${Object.keys(results).join(", ")}`);
      ok(ctrl.includes("namespace My.Company.Orders.Controllers"), `expected 'namespace My.Company.Orders.Controllers' in:\n${ctrl}`);
    });
  });

  describe("helpers generation", () => {
    it("infers helper namespace from the TypeSpec namespace when root-namespace is not set", async () => {
      const results = await emit(`
        namespace Demo;
        model M { x: int32; }
      `, { "emit-helpers": true });

      const helper = results["Helpers/EnumMemberConverter.g.cs"];
      ok(helper, `expected Helpers/EnumMemberConverter.g.cs, got ${Object.keys(results).join(", ")}`);
      ok(helper.includes("namespace Demo.Helpers"), `expected 'namespace Demo.Helpers' in:\n${helper}`);
    });

    it("uses explicit root-namespace for helpers when provided", async () => {
      const results = await emit(`
        namespace Demo;
        model M { x: int32; }
      `, { "emit-helpers": true, "root-namespace": "MyApp" });

      const helper = results["Helpers/EnumMemberConverter.g.cs"];
      ok(helper, `expected Helpers/EnumMemberConverter.g.cs`);
      ok(helper.includes("namespace MyApp.Helpers"), `expected 'namespace MyApp.Helpers' in:\n${helper}`);
    });
  });
});
