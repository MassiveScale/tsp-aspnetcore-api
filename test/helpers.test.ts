import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("csharp emitter - helpers", () => {
  describe("type mapping", () => {
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
});
