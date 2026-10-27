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

const SPEC = (versionAware: boolean) => `
  import "@typespec/http";
  import "@typespec/versioning";
  using TypeSpec.Http;
  using TypeSpec.Versioning;

  ${versionAware ? "@versioned(Versions)" : ""}
  @service namespace Demo;
  ${versionAware ? 'enum Versions { v1: "v1", v2: "v2" }' : ""}

  enum Theme { light, dark }
  model WidgetLayout { density?: int32 = 10; }
  model WidgetAppearance {
    label: string;
    theme?: Theme = Theme.light;
    @minValue(8) @maxValue(72) fontSize?: int32 = 14;
    layout?: WidgetLayout = #{};
  }
  model WidgetSlot { name: string; }
  @discriminator("kind")
  model Gadget {
    @encodedName("application/json", "$type") kind: string;
    @maxLength(4) label?: string;
  }
  model Gear extends Gadget {
    kind: "gear";
    ${versionAware ? "@added(Versions.v2)" : ""}
    @minValue(2) teeth?: int32;
    friend?: Gadget;
    layout?: WidgetLayout;
    variantValue?: string;
  }
  model Cog extends Gadget { kind: "cog"; size?: int32 = 3; variantValue?: int32 = 7; }
  @discriminator("kind") model PlainPet { kind: string; @maxLength(4) name?: string; }
  model PlainDog extends PlainPet { kind: "dog"; @minValue(10) value?: int32; required: string; }
  model Widget {
    name?: string;
    appearance?: WidgetAppearance = #{ label: "default", layout: #{} };
    values?: int32[];
    slots?: WidgetSlot[];
    gadgets?: Gadget[];
    gadget?: Gadget;
    gear?: Gear;
    catalog?: Record<Gadget>;
    labels?: Record<string>;
    groups?: Record<Record<string>>;
    extra?: unknown;
  }
  model WidgetPatch is MergePatchUpdate<Widget>;

  @route("/widgets") interface Widgets {
    @patch update(@body body: WidgetPatch): void;
  }
  @route("/plain") @patch op updatePlain(@body body: PlainPet): void;
  @route("/plain") @post op createPlain(@body body: PlainPet): void;
`;

async function runGeneratedHelper(
  style: "generic" | "typed",
  versionAware = false,
): Promise<void> {
  const files = await emit(SPEC(versionAware), {
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
      const destination = join(directory, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, content, "utf8");
    }

    await writeFile(
      join(directory, "Runtime.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /><PackageReference Include="FluentValidation" Version="12.1.1" /></ItemGroup></Project>`,
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
using Microsoft.Extensions.DependencyInjection;
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

widget.Labels = new Dictionary<string, string> { ["env"] = "dev", ["Team"] = "core" };
Patch(widget, """{"labels":{"env":"prod","owner":"ops","Team":null}}""");
Check(widget.Labels is { Count: 2 } && widget.Labels["env"] == "prod" && widget.Labels["owner"] == "ops", "dictionary keys must merge, and a null value must remove the key");

widget.Groups = new Dictionary<string, IDictionary<string, string>> { ["a"] = new Dictionary<string, string> { ["x"] = "1" } };
var groupsApplied = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"groups":{"a":{"y":"2"},"b":{"z":"3"}}}""").TryPatch(widget, out var groupsRejected);
Check(groupsApplied && groupsRejected.Count == 0, "nested dictionary keys must not be rejected as unknown members");
Check(widget.Groups["a"]["x"] == "1" && widget.Groups["a"]["y"] == "2" && widget.Groups["b"]["z"] == "3", "nested dictionaries must merge recursively");

Patch(widget, """{"extra":{"a":1}}""");
var extraApplied = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"extra":{"b":{"c":2}}}""").TryPatch(widget, out var extraRejected);
var extra = (System.Text.Json.JsonElement)widget.Extra!;
Check(extraApplied && extraRejected.Count == 0 && extra.GetProperty("a").GetInt32() == 1 && extra.GetProperty("b").GetProperty("c").GetInt32() == 2, "free-form JSON values must accept and merge any key");

widget.Name = "before";
Patch(widget, """{"name":"after","values":[7],"appearance":{"label":"both"}}""");
Check(widget.Name == "after" && widget.Values is [7] && widget.Appearance.Label == "both", "several properties must apply together");

var services = new ServiceCollection();
services.AddSingleton(Microsoft.Extensions.Options.Options.Create(new Microsoft.AspNetCore.Mvc.JsonOptions()));
services.AddHttpContextAccessor();
services.AddGeneratedValidators();
using var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true });
var widgetValidator = provider.GetRequiredService<WidgetPatchValidator>();
${
  versionAware
    ? `
var accessor = provider.GetRequiredService<Microsoft.AspNetCore.Http.IHttpContextAccessor>();
accessor.HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext();
accessor.HttpContext.Request.Headers["api-version"] = "v2";
`
    : ""
}

var abstractItem = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"gadgets":[{"teeth":3}]}""");
var abstractResult = widgetValidator.Validate(abstractItem);
Check(abstractResult.Errors.Any(failure => failure.PropertyName == "Gadgets[0]"), "an abstract array item without a discriminator must fail validation instead of throwing");

var webCasing = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"slots":[{"Name":"upper"}]}""");
var webCasingResult = widgetValidator.Validate(webCasing);
Check(webCasingResult.IsValid, "array items must be read with the application's JSON options (case-insensitive names)");
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

FluentValidation.Results.ValidationResult ValidateGadget(string json) =>
    widgetValidator.Validate(${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson(json));

var derivedFailure = ValidateGadget("""{"gadget":{"$type":"gear","teeth":1,"label":"too long"}}""");
Check(derivedFailure.Errors.Count(failure => failure.PropertyName == "Gadget.Teeth") == 1, "derived-only properties must be validated exactly once");
Check(derivedFailure.Errors.Count(failure => failure.PropertyName == "Gadget.Label") == 1, "inherited properties must be validated exactly once");
Check(ValidateGadget("""{"gadget":{"$type":"gear"}}""").IsValid, "a discriminated object must remain a partial update");
foreach (var json in new[] {
    """{"gadget":{}}""",
    """{"gadget":{"teeth":3}}""",
    """{"gadget":{"$type":"missing"}}""",
    """{"gadget":{"$type":null}}""",
    """{"gadget":{"$type":4}}"""
})
    Check(ValidateGadget(json).Errors.Any(failure => failure.PropertyName == "Gadget.$type"), "nested discriminators must be present, string-valued, and recognized");
Check(ValidateGadget("""{}""").IsValid && ValidateGadget("""{"gadget":null}""").IsValid, "omitted and nullable nested properties do not require a discriminator");
Check(ValidateGadget("""{"gadget":{"$TYPE":"gear","teeth":2}}""").IsValid, "discriminator property lookup must follow case-insensitive patch lookup");
Check(ValidateGadget("""{"catalog":{"first":{"$type":"gear","teeth":1}}}""").Errors.Any(failure => failure.PropertyName == "Catalog[first].Teeth"), "record values must dispatch to derived PATCH validators");
Check(ValidateGadget("""{"catalog":{"first":{}}}""").Errors.Any(failure => failure.PropertyName == "Catalog[first].$type"), "record values must require discriminators");
Check(ValidateGadget("""{"catalog":{"first":null}}""").IsValid, "record deletions do not require discriminators");
Check(ValidateGadget("""{"gadget":{"$type":"gear","friend":{"$type":"gear","teeth":1}}}""").Errors.Any(failure => failure.PropertyName == "Gadget.Friend.Teeth"), "recursive polymorphic patches must resolve validators lazily");
Check(ValidateGadget("""{"gadget":{"$type":"gear","layout":{"density":4}}}""").IsValid, "derived-only nested models must have registered PATCH validators");

bool ApplyGadget(Widget target, string json, out System.Collections.Generic.IReadOnlyList<string> rejectedPaths)
{
    var patch = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson(json);
    Check(widgetValidator.Validate(patch).IsValid, "the end-to-end patch must first pass validation");
    return patch.TryPatch(target, out rejectedPaths);
}
var gear = new Gear { Teeth = 5, Label = "old", VariantValue = "old subtype" };
var polymorphic = new Widget { Gadget = gear };
Check(ApplyGadget(polymorphic, """{"gadget":{"$type":"gear","teeth":6}}""", out var sameRejected) && sameRejected.Count == 0, "matching discriminator metadata must not be rejected");
Check(ReferenceEquals(polymorphic.Gadget, gear) && gear.Teeth == 6, "same-type patches preserve object identity");
foreach (var tag in new[] { "null", "4", "\\"unknown\\"" })
{
    var invalid = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("{\\"gadget\\":{\\"$type\\":" + tag + ",\\"teeth\\":1}}");
    Check(!invalid.TryPatch(polymorphic, out _) && ReferenceEquals(polymorphic.Gadget, gear) && gear.Teeth == 6, "application must reject invalid tags without relying on validation");
}
Check(ApplyGadget(polymorphic, """{"name":"ok","gadget":{"size":4,"$TYPE":"cog"}}""", out var replacementRejected) && replacementRejected.Count == 0, "a different discriminator must replace the nested model");
Check(polymorphic.Gadget is Cog { Label: "old", Size: 4, VariantValue: 7 } && gear.Teeth == 6 && gear.Label == "old" && polymorphic.Name == "ok", "replacement must preserve compatible shared fields, discard incompatible same-name fields, apply new fields, and leave the old instance untouched");
Check(ApplyGadget(polymorphic, """{"gadget":{"$type":"gear","teeth":8,"label":"new"}}""", out _) && polymorphic.Gadget is Gear { Label: "new", Teeth: 8 }, "subtype changes must work in both directions and allow shared-field overrides");
var metadataOnly = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"gadget":{"$type":"cog"}}""");
var strictJson = new System.Text.Json.JsonSerializerOptions { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
Check(metadataOnly.TryPatch(polymorphic, out _, strictJson) && polymorphic.Gadget is Cog { Label: "new", Size: 3 }, "metadata-only replacement must discard old subtype fields and apply new subtype defaults");
var beforeInvalidReplacement = polymorphic.Gadget;
var invalidReplacement = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"gadget":{"$type":"gear","teeth":"bad"}}""");
Check(!invalidReplacement.TryPatch(polymorphic, out var invalidReplacementPaths) && invalidReplacementPaths.Contains("gadget.teeth") && ReferenceEquals(polymorphic.Gadget, beforeInvalidReplacement), "a replacement that cannot deserialize must report its path and leave the existing value unchanged");
var concreteProperty = new Widget { Gear = gear };
var incompatibleReplacement = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"gear":{"$type":"cog","size":9}}""");
Check(!incompatibleReplacement.TryPatch(concreteProperty, out var incompatiblePaths) && incompatiblePaths.Contains("gear.$type") && ReferenceEquals(concreteProperty.Gear, gear), "replacement must remain assignable to the declared property type");
var recursive = new Widget { Gadget = new Gear { Teeth = 5, Friend = new Gear { Teeth = 6, Label = "keep" } } };
Check(ApplyGadget(recursive, """{"gadget":{"$type":"gear","friend":{"$type":"cog","size":9}}}""", out _) && recursive.Gadget is Gear { Friend: Cog { Label: "keep", Size: 9 } }, "subtype replacement must work at deeper nested levels");
var missingGadget = new Widget();
Check(ApplyGadget(missingGadget, """{"gadget":{"teeth":7,"$TYPE":"gear"}}""", out _) && missingGadget.Gadget is Gear { Teeth: 7 }, "a missing polymorphic value must be created with canonical metadata regardless of tag order or casing");
var dictionary = new Widget { Catalog = new Dictionary<string, Gadget> { ["a"] = new Gear { Teeth = 5, Label = "old" } } };
Check(ApplyGadget(dictionary, """{"catalog":{"a":{"$type":"gear","teeth":6},"b":{"$type":"cog","size":3}}}""", out _) && dictionary.Catalog["a"] is Gear { Teeth: 6 } && dictionary.Catalog["b"] is Cog { Size: 3 }, "dictionary values must merge and materialize as concrete types");
Check(ApplyGadget(dictionary, """{"catalog":{"a":{"$type":"cog","size":9},"b":{"$type":"cog","size":4}}}""", out var dictionaryRejected) && dictionaryRejected.Count == 0 && dictionary.Catalog["a"] is Cog { Label: "old", Size: 9 } && dictionary.Catalog["b"] is Cog { Size: 4 }, "dictionary subtype changes must preserve shared fields and apply valid siblings");
Check(ApplyGadget(dictionary, """{"catalog":{"a":{"$type":"gear","teeth":7}}}""", out _) && dictionary.Catalog["a"] is Gear { Label: "old", Teeth: 7 }, "dictionary subtype changes must work in both directions");
var invalidDictionary = ${style === "generic" ? "MergePatch<Widget>" : "WidgetMergePatchUpdate"}.FromJson("""{"catalog":{"a":{"$type":"unknown","teeth":1},"b":{"$type":"cog","size":5}}}""");
Check(!invalidDictionary.TryPatch(dictionary, out var invalidDictionaryPaths) && invalidDictionaryPaths.Contains("catalog.a.$type") && dictionary.Catalog["a"] is Gear { Teeth: 7 } && dictionary.Catalog["b"] is Cog { Size: 5 }, "an invalid dictionary tag must leave its entry unchanged while valid siblings apply");
Check(ApplyGadget(dictionary, """{"catalog":{"a":null}}""", out _) && !dictionary.Catalog.ContainsKey("a"), "polymorphic dictionary entries must still support deletion");
Check(ApplyGadget(new Widget(), """{"catalog":{"a":{"$type":"gear","teeth":8}}}""", out _), "a missing dictionary must support polymorphic creation");
var rootPatch = ${style === "generic" ? "MergePatch<Gadget>" : "GadgetMergePatchUpdate"}.FromJson("""{"$type":"cog","teeth":1}""");
Check(!rootPatch.TryPatch(gear, out var rootRejected) && rootRejected.Contains("$type") && gear.Teeth == 6, "a root mismatch must not mutate the entity");
var matchingRoot = ${style === "generic" ? "MergePatch<Gadget>" : "GadgetMergePatchUpdate"}.FromJson("""{"$type":"gear","teeth":9}""");
Check(matchingRoot.TryPatch(gear, out _) && gear.Teeth == 9, "matching root metadata must be accepted");
var plainValidator = provider.GetRequiredService<PlainPetPatchValidator>();
var plainFailure = plainValidator.Validate(new PlainDog { Value = 1, Name = "long name" });
Check(plainFailure.Errors.Count(f => f.PropertyName == "Value") == 1 && plainFailure.Errors.Count(f => f.PropertyName == "Name") == 1, "plain PATCH dispatch must validate derived and inherited constraints exactly once");
Check(plainValidator.Validate(new PlainDog { Value = 10 }).IsValid, "plain PATCH must inject PATCH rather than POST rules when both exist");
${
  versionAware
    ? `
accessor.HttpContext.Request.Headers["api-version"] = "v1";
Check(ValidateGadget("""{"gadget":{"$type":"gear","teeth":1}}""").IsValid, "derived PATCH rules must honor the requested API version");
accessor.HttpContext.Request.Headers["api-version"] = "v2";
Check(!ValidateGadget("""{"gadget":{"$type":"gear","teeth":1}}""").IsValid, "derived PATCH rules must read the API version per validation");
`
    : ""
}
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
        { cause: error },
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
    it(`dispatches version-aware polymorphic patches with ${style} helpers`, async () => {
      await runGeneratedHelper(style, true);
    });
  }
});

const AWKWARD_NAMES_SPEC = `
  import "@typespec/http";
  using TypeSpec.Http;

  @service namespace Demo;

  enum Mode { \`a-b\`, aB, \`1x\` }

  @doc("Use <b> & keep a > b")
  model Error {
    error: string;
    user_id: string;
    userId: string;
    \`1st\`: string;
    \`$ref\`: string;
    mode?: Mode = Mode.aB;
    status?: "in-progress" | "" = "";
    pet?: Pet = #{ kind: "say \\"woof\\"", name: "Rex" };
    pets?: Pet[] = #[#{ kind: "say \\"woof\\"", name: "Spot" }];
  }

  @discriminator("kind")
  model Pet {
    @encodedName("application/json", "$type") kind: string;
    name: string;
  }
  model Dog extends Pet { kind: "say \\"woof\\""; }

  @route("/items/{class}") interface Items {
    @post create(
      @path \`class\`: string,
      @query body: string,
      @query \`2fa\`: string,
      @query cancellationToken: string,
      @body payload: Error,
    ): Pet;
  }
`;

const AWKWARD_NAMES_PROGRAM = `using System.Text.Json;
using Demo.Models;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var error = new Error { ErrorValue = "e", UserId = "snake", UserId2 = "camel", _1st = "first", Ref = "r" };
Check(error.Pet is Dog { Name: "Rex" }, "discriminated defaults must instantiate the concrete subtype with inherited properties");
Check(error.Pets is [Dog { Name: "Spot" }], "array defaults must instantiate concrete subtypes");
var other = new Error();
error.Pet!.Name = "changed";
Check(other.Pet is Dog { Name: "Rex" }, "discriminated defaults must not share instances");
var json = JsonSerializer.Serialize(error);
Check(json.Contains("\\"error\\":\\"e\\"") && json.Contains("\\"user_id\\":\\"snake\\"") && json.Contains("\\"userId\\":\\"camel\\""), json);
Check(json.Contains("\\"1st\\":\\"first\\"") && json.Contains("\\"$ref\\":\\"r\\""), json);
Check(json.Contains("\\"mode\\":\\"aB\\"") && json.Contains("\\"status\\":\\"\\""), json);
var roundTrip = JsonSerializer.Deserialize<Error>(json);
Check(roundTrip?.Pet is Dog { Name: "changed" }, "discriminated defaults must round-trip through JSON");

var pet = JsonSerializer.Deserialize<Pet>("""{"$type":"say \\"woof\\"","name":"Rex"}""");
Check(pet is Dog { Name: "Rex" }, "polymorphic deserialization must use the encoded discriminator name");
`;

describe("generated code with awkward names", { skip: !hasDotnet }, () => {
  it("compiles and round-trips JSON with default options", async () => {
    const files = await emit(AWKWARD_NAMES_SPEC);
    const directory = await mkdtemp(join(tmpdir(), "awkward-names-"));

    try {
      for (const [path, content] of Object.entries(files)) {
        if (!path.endsWith(".g.cs")) continue;
        const destination = join(directory, path);
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, content, "utf8");
      }
      await writeFile(
        join(directory, "Runtime.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /></ItemGroup></Project>`,
        "utf8",
      );
      await writeFile(
        join(directory, "Program.cs"),
        AWKWARD_NAMES_PROGRAM,
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
          { cause: error },
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
