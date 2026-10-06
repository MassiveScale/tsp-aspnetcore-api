import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { emit } from "./host.js";

const hasDotnet =
  spawnSync("dotnet", ["--version"], {
    stdio: "ignore",
  }).status === 0;

const SPEC = `
  import "@typespec/http";
  using TypeSpec.Http;

  @service namespace Demo;

  enum Theme { light, dark }
  model WidgetLayout { density?: int32 = 10; }
  model WidgetAppearance {
    label: string;
    theme?: Theme = Theme.light;
    @minValue(8) @maxValue(72) fontSize?: int32 = 14;
    layout?: WidgetLayout = #{};
  }
  model WidgetSlot { name: string; }
  model Widget {
    name?: string;
    appearance?: WidgetAppearance = #{ label: "default", layout: #{} };
    values?: int32[];
    slots?: WidgetSlot[];
  }
  model WidgetPatch is MergePatchUpdate<Widget>;

  @route("/widgets") interface Widgets {
    @patch update(@body body: WidgetPatch): void;
  }
`;

async function runGeneratedHelper(style: "generic" | "typed"): Promise<void> {
  const files = await emit(SPEC, {
    "merge-patch-style": style,
    "emit-controllers": false,
    "emit-services": false,
    "emit-interfaces": false,
    "emit-validators": true,
    "emit-helpers": true,
  });
  const directory = await mkdtemp(join(tmpdir(), "nested-merge-patch-"));

  try {
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith(".g.cs")) continue;
      if (
        !path.startsWith("Models/") &&
        !path.startsWith("Helpers/") &&
        !path.startsWith("Validators/")
      )
        continue;
      if (path.endsWith("ValidatorsInitializer.g.cs")) continue;
      const destination = join(directory, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, content, "utf8");
    }

    await writeFile(
      join(directory, "Runtime.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><PackageReference Include="FluentValidation" Version="12.1.1" /></ItemGroup></Project>`,
      "utf8",
    );
    const patchFactory =
      style === "generic"
        ? "MergePatch<Widget>.FromJson(json)"
        : "WidgetMergePatchUpdate.FromJson(json)";
    await writeFile(
      join(directory, "Program.cs"),
      `using Demo.Models;
    using Demo.Validators;
using ${style === "generic" ? "Demo.Helpers" : "Demo.Models"};

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Patch(Widget target, string json)
{
    var patch = ${patchFactory};
    patch.Patch(target);
}

var first = new Widget();
var second = new Widget();
first.Appearance!.FontSize = 21;
Check(second.Appearance!.FontSize == 14, "object defaults must not be shared between instances");

var widget = new Widget();
widget.Appearance!.Theme = Theme.Dark;
widget.Appearance.FontSize = 20;
Patch(widget, """{"appearance":{"theme":"light"}}""");
Check(widget.Appearance.Theme == Theme.Light && widget.Appearance.FontSize == 20, "nested object must merge into existing target");

Patch(widget, """{"appearance":{"fontSize":null}}""");
Check(widget.Appearance.FontSize == 14 && widget.Appearance.Theme == Theme.Light, "nested null must restore the member default");

widget.Appearance.Theme = Theme.Dark;
widget.Appearance.FontSize = 20;
Patch(widget, """{"appearance":{}}""");
Check(widget.Appearance.Theme == Theme.Dark && widget.Appearance.FontSize == 20, "empty object must not change existing values");

Patch(widget, """{"appearance":null}""");
Check(widget.Appearance is not null && widget.Appearance.FontSize == 14 && widget.Appearance.Theme == Theme.Light, "object null must restore the object default");

widget.Appearance = null;
Patch(widget, """{"appearance":{"layout":{"density":25}}}""");
Check(widget.Appearance?.Layout?.Density == 25 && widget.Appearance.Theme == Theme.Light, "missing target objects must be created with defaults");

Patch(widget, """{"APPEARANCE":{"FONTSIZE":32}}""");
Check(widget.Appearance.FontSize == 32, "wire property matching must be case-insensitive");

widget.Values = new List<int> { 1, 2 };
Patch(widget, """{"values":[3]}""");
Check(widget.Values is { Count: 1 } && widget.Values[0] == 3, "arrays must replace rather than merge");

var rejected = new ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}();
rejected.Properties["name"] = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize("updated")).RootElement.Clone();
rejected.Properties["appearance"] = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new { fontSize = 99, unknown = 1 })).RootElement.Clone();
var applied = rejected.TryPatch(widget, out var rejectedPaths);
Check(!applied && rejectedPaths.Contains("appearance.unknown"), "TryPatch must return the rejected nested JSON path");
Check(widget.Name == "updated" && widget.Appearance.FontSize == 99, "valid siblings apply while unknown nested members are skipped");

var invalidShape = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson(System.Text.Json.JsonSerializer.Serialize(new { appearance = "dark" }));
var appliedInvalidShape = invalidShape.TryPatch(widget, out var invalidShapePaths);
Check(!appliedInvalidShape && invalidShapePaths.Any(path => path.Contains("appearance", StringComparison.OrdinalIgnoreCase)), "TryPatch must report a non-object model value");
Check(widget.Appearance.FontSize == 99, "a non-object nested value must leave its target unchanged");

var widgetValidator = new WidgetPatchValidator(new WidgetAppearancePatchValidator(new WidgetLayoutPatchValidator()), new WidgetSlotValidator());
var invalidEnum = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"appearance":{"theme":"neon"}}""");
var enumResult = widgetValidator.Validate(invalidEnum);
Check(enumResult.Errors.Any(failure => failure.PropertyName == "Appearance.Theme"), "invalid nested enum must fail at its dotted path");

var invalidBound = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"appearance":{"fontSize":4}}""");
var boundResult = widgetValidator.Validate(invalidBound);
Check(boundResult.Errors.Any(failure => failure.PropertyName == "Appearance.FontSize"), "invalid nested bounds must fail at their dotted path");

var missingRequired = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"appearance":{"label":null}}""");
var requiredResult = widgetValidator.Validate(missingRequired);
Check(requiredResult.Errors.Any(failure => failure.PropertyName == "Appearance.Label"), "required nested members must reject null");

var invalidArrayItem = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"slots":[{}]}""");
var arrayResult = widgetValidator.Validate(invalidArrayItem);
Check(arrayResult.Errors.Any(failure => failure.PropertyName == "Slots[0].Name"), "replacement array items must receive complete model validation");
`,
      "utf8",
    );

    try {
      execFileSync(
        "dotnet",
        [
          "run",
          "--project",
          join(directory, "Runtime.csproj"),
          "--verbosity",
          "quiet",
        ],
        { stdio: "pipe" },
      );
    } catch (error) {
      const result = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("generated merge-patch runtime behavior", { skip: !hasDotnet }, () => {
  for (const style of ["generic", "typed"] as const) {
    it(`recursively merges nested values with ${style} helpers`, async () => {
      await runGeneratedHelper(style);
    });
  }
});
