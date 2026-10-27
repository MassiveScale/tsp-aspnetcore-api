import { ok, strictEqual } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

/** JSON wire name of a camelCase TypeSpec property, given its C# name. */
function wireName(csharpName: string): string {
  return csharpName[0].toLowerCase() + csharpName.slice(1);
}

function describeDiagnostics(
  diagnostics: readonly { code: string; message: string }[],
): string {
  return diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
}

function writeTemplate(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csharp-tpl-"));
  const file = join(dir, `${name}.hbs`);
  writeFileSync(file, content);
  return file;
}

describe("csharp emitter - validators", () => {
  describe("@discriminator decorator", () => {
    it("dispatches plain PATCH bodies to concrete PATCH validators across version strategies", async () => {
      const source = `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;
        @service @versioned(Versions) namespace Demo;
        enum Versions { v1: "v1", v2: "v2" }
        @discriminator("kind") model Pet { kind: string; name?: string; }
        model Dog extends Pet { kind: "dog"; @added(Versions.v2) @minValue(10) value?: int32; }
        @route("/pets") @patch op update(@body body: Pet): void;
        @route("/pets") @post op create(@body body: Pet): void;
      `;
      for (const strategy of ["earliest", "per-version", "version-aware"]) {
        const files = await emit(source, {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "validators-version-strategy": strategy,
          "fully-qualified-types": true,
        });
        for (const directory of strategy === "per-version"
          ? ["v1/", "v2/"]
          : [""]) {
          const base = files[`Validators/${directory}PetPatchValidator.g.cs`];
          ok(base.includes("DogPatchValidator dogPatchValidator"), base);
          ok(base.includes("v.Add<Demo.Models.Dog>(dogPatchValidator)"), base);
          ok(
            base.includes("When(x => !_derivedTypes.Contains(x.GetType())"),
            base,
          );
          ok(files[`Validators/${directory}DogPatchValidator.g.cs`]);
        }
      }
    });

    it("omits discriminator properties from generated validators", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }

        @route("/pets")
        interface Pets {
          @post create(@body body: Pet): Pet;
        }
      `,
        {
          "emit-validators": true,
          validators: "post",
          "emit-controllers": false,
          "emit-services": false,
        },
      );

      const petValidator = results["Validators/PetValidator.g.cs"];
      ok(petValidator, "expected Validators/PetValidator.g.cs");
      ok(
        !petValidator.includes("RuleFor(x => x.Kind)"),
        `discriminator property should not be validated:\n${petValidator}`,
      );
      ok(
        petValidator.includes("RuleFor(x => x.Name)"),
        `expected regular properties to still be validated:\n${petValidator}`,
      );
    });

    it("emits SetInheritanceValidator for discriminated base-class validators", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; bark: boolean; }
        model Cat extends Pet { kind: "cat"; purr: boolean; }

        @route("/pets")
        interface Pets {
          @post create(@body body: Pet): Pet;
        }
      `,
        {
          "emit-validators": true,
          validators: "post",
          "emit-controllers": false,
          "emit-services": false,
        },
      );

      const petValidator = results["Validators/PetValidator.g.cs"];
      ok(petValidator, "expected Validators/PetValidator.g.cs");
      ok(
        petValidator.includes("SetInheritanceValidator"),
        `expected SetInheritanceValidator in base validator:\n${petValidator}`,
      );
      ok(
        petValidator.includes("v.Add<Cat>(catValidator)"),
        `expected Cat dispatch in base validator:\n${petValidator}`,
      );
      ok(
        petValidator.includes("v.Add<Dog>(dogValidator)"),
        `expected Dog dispatch in base validator:\n${petValidator}`,
      );
      // Constructor should accept derived-type validators
      ok(
        petValidator.includes("AbstractValidator<Cat> catValidator"),
        `expected Cat validator parameter:\n${petValidator}`,
      );
      ok(
        petValidator.includes("AbstractValidator<Dog> dogValidator"),
        `expected Dog validator parameter:\n${petValidator}`,
      );
    });

    it("emits a validator for a grandchild in a multi-level discriminated hierarchy", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { bark: boolean; }
        model Labrador extends Dog { kind: "labrador"; }
        model Poodle extends Dog { kind: "poodle"; }

        @route("/pets")
        interface Pets {
          @post create(@body body: Pet): Pet;
        }
      `,
        {
          "emit-validators": true,
          validators: "post",
          "emit-controllers": false,
          "emit-services": false,
        },
      );

      const petValidator = results["Validators/PetValidator.g.cs"];
      ok(petValidator, "expected Validators/PetValidator.g.cs");
      ok(
        petValidator.includes("AbstractValidator<Labrador> labradorValidator"),
        `expected Labrador validator parameter:\n${petValidator}`,
      );

      // The grandchildren must have their own validators emitted, otherwise nothing
      // registers AbstractValidator<Labrador>/<Poodle> in DI and the constructor above fails to resolve.
      const labradorValidator = results["Validators/LabradorValidator.g.cs"];
      ok(
        labradorValidator,
        "expected Validators/LabradorValidator.g.cs to be emitted",
      );
      const poodleValidator = results["Validators/PoodleValidator.g.cs"];
      ok(
        poodleValidator,
        "expected Validators/PoodleValidator.g.cs to be emitted",
      );
    });

    it("does not emit SetInheritanceValidator for non-discriminated models", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Widget { name: string; }

        @route("/widgets")
        interface Widgets {
          @post create(@body body: Widget): Widget;
        }
      `,
        {
          "emit-validators": true,
          validators: "post",
          "emit-controllers": false,
          "emit-services": false,
        },
      );

      const widgetValidator = results["Validators/WidgetValidator.g.cs"];
      ok(widgetValidator, "expected Validators/WidgetValidator.g.cs");
      ok(
        !widgetValidator.includes("SetInheritanceValidator"),
        `SetInheritanceValidator should not appear for non-discriminated models:\n${widgetValidator}`,
      );
    });
  });

  describe("per-section namespace options", () => {
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
  });

  describe("@serverName decorator", () => {
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

  describe("custom validator templates", () => {
    const spec = `
      import "@typespec/http";
      using TypeSpec.Http;

      @service(#{ title: "Shop" })
      namespace Demo;

      model Widget { name: string; }
      model Gadget { name: string; }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
        @patch(#{ implicitOptionality: false }) update(
          @path id: string,
          @body body: MergePatchUpdate<Widget>,
        ): Widget;
      }

      @route("/gadgets")
      interface Gadgets {
        @post create(@body body: Gadget): Gadget;
      }
    `;

    it("renders every model's validator from the same override", async () => {
      const tpl = writeTemplate(
        "validator-post",
        "custom {{modelName}}\r\n{{#each additionalUsings}}using {{this}};\r\n{{/each}}",
      );

      const results = await emit(spec, {
        "emit-validators": true,
        "additional-usings": ["Acme.Shared"],
        templates: { "validator-post": tpl },
      });

      strictEqual(
        results["Validators/WidgetValidator.g.cs"],
        "custom Widget\nusing Acme.Shared;\n",
      );
      strictEqual(
        results["Validators/GadgetValidator.g.cs"],
        "custom Gadget\nusing Acme.Shared;\n",
      );
    });

    it("does not HTML-escape double-brace values in validator templates", async () => {
      const tpl = writeTemplate(
        "validator-patch",
        "{{qualifiedPatchBodyTypeName}}|{{{qualifiedPatchBodyTypeName}}}",
      );

      const results = await emit(spec, {
        "emit-validators": true,
        templates: { "validator-patch": tpl },
      });

      strictEqual(
        results["Validators/WidgetPatchValidator.g.cs"],
        "MergePatch<Widget>|MergePatch<Widget>",
      );
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
          "fully-qualified-types": true,
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

  describe("nullable nested-model references", () => {
    const NESTED_MODEL_SOURCE = `
      import "@typespec/http";
      using TypeSpec.Http;

      @service
      namespace Demo;

      model Author { name: string; }
      model Tag { name: string; }

      model Book {
        id: string;
        author: Author;
        tags: Tag[];
      }

      model BookPatch is MergePatchUpdate<Book>;

      interface Books {
        @route("/books")
        @post create(@body body: Book): Book;

        @route("/books/{id}")
        @patch update(@path id: string, @body body: BookPatch): Book;
      }
    `;

    it("emits the null-forgiving operator and a .When guard for nullable scalar and collection references in POST validators", async () => {
      const results = await emit(NESTED_MODEL_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });

      const postValidator = results["Validators/BookValidator.g.cs"];
      ok(
        postValidator,
        `expected Validators/BookValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        postValidator.includes(
          "RuleFor(x => x.Author!).SetValidator(authorValidator).When(x => x.Author is not null);",
        ),
        `expected nullable scalar reference rule in:\n${postValidator}`,
      );
      ok(
        postValidator.includes(
          "RuleForEach(x => x.Tags!).SetValidator(tagValidator).When(x => x.Tags is not null);",
        ),
        `expected nullable collection reference rule in:\n${postValidator}`,
      );

      const patchValidator = results["Validators/BookPatchValidator.g.cs"];
      ok(
        patchValidator,
        `expected Validators/BookPatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        patchValidator.includes("AbstractValidator<MergePatch<Book>>"),
        `expected the patch validator to target the MergePatch body in:\n${patchValidator}`,
      );
      ok(
        patchValidator.includes(
          "AbstractValidator<MergePatch<Author>> authorPatchValidator",
        ) && patchValidator.includes("AbstractValidator<Tag> tagValidator"),
        `expected injected nested patch and array-item validators in:\n${patchValidator}`,
      );
      ok(
        patchValidator.includes("'Author' must be an object.") &&
          patchValidator.includes("MergePatch<Author>.FromJson") &&
          patchValidator.includes('$"Author.{failure.PropertyName}"'),
        `expected nested-object shape validation and dotted failure paths in:\n${patchValidator}`,
      );
      ok(
        patchValidator.includes(
          "JsonSerializer.Deserialize<Tag>(item.GetRawText(), jsonSerializerOptions)",
        ) && patchValidator.includes('$"Tags[{index}].{failure.PropertyName}"'),
        `expected full-model array-item validation in:\n${patchValidator}`,
      );
    });

    it("reads nested values with the application's MVC JSON options", async () => {
      const results = await emit(NESTED_MODEL_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });
      const patchValidator = results["Validators/BookPatchValidator.g.cs"];
      ok(
        patchValidator.includes(
          "public BookPatchValidator(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Mvc.JsonOptions> jsonOptions, AbstractValidator<MergePatch<Author>> authorPatchValidator, AbstractValidator<Tag> tagValidator)",
        ),
        `expected JsonOptions as the first constructor parameter in:\n${patchValidator}`,
      );
      ok(
        patchValidator.includes(
          "var jsonSerializerOptions = jsonOptions.Value.JsonSerializerOptions;",
        ) &&
          patchValidator.includes(
            "MergePatch<Author>.FromJson(element.GetRawText(), jsonSerializerOptions)",
          ),
        `expected nested patches to use the configured options in:\n${patchValidator}`,
      );

      const authorPatch = results["Validators/AuthorPatchValidator.g.cs"];
      ok(
        authorPatch.includes("public AuthorPatchValidator()") &&
          !authorPatch.includes("jsonOptions"),
        `expected validators without nested values to keep a parameterless constructor:\n${authorPatch}`,
      );
    });

    it("turns array-item deserialization failures into validation failures", async () => {
      const results = await emit(NESTED_MODEL_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });
      const patchValidator = results["Validators/BookPatchValidator.g.cs"];
      ok(
        patchValidator.includes(
          "catch (System.Exception ex) when (ex is System.Text.Json.JsonException or System.NotSupportedException or System.InvalidOperationException)",
        ) &&
          patchValidator.includes(
            '"The array item could not be deserialized."',
          ),
        `expected abstract-item failures to be caught in:\n${patchValidator}`,
      );
    });

    it("indents nested MergePatch rules with the surrounding code", async () => {
      const results = await emit(NESTED_MODEL_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });
      const lines =
        results["Validators/BookPatchValidator.g.cs"].split(/\r?\n/);
      ok(
        lines.some((line) => line.startsWith("    public BookPatchValidator(")),
        "expected a 4-space constructor",
      );
      ok(
        lines
          .filter((line) => line.includes(".Custom((patch, context) =>"))
          .every((line) => line.startsWith("        this.RuleFor")),
        "expected nested rules at the 8-space statement indent",
      );
      ok(
        !lines.some((line) => line.length > 0 && line.trim().length === 0),
        "expected no whitespace-only lines",
      );
      const usingEnd = lines.findIndex((line) => line.startsWith("namespace "));
      strictEqual(
        lines[usingEnd - 2].startsWith("using "),
        true,
        "expected exactly one blank line between the usings and the namespace",
      );
    });

    it("emits recursive nested MergePatch validators for children reachable only from PATCH", async () => {
      const source = `
        import "@typespec/http";
        using TypeSpec.Http;

        @service namespace Demo;

        enum Theme { light, dark }
        model Leaf { @minValue(8) @maxValue(72) fontSize?: int32; }
        model Appearance { label: string; theme?: Theme; leaf?: Leaf; }
        model Widget { appearance?: Appearance; }
        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets") interface Widgets {
          @patch update(@body body: WidgetPatch): void;
        }
      `;

      for (const style of ["generic", "typed"] as const) {
        const results = await emit(source, {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
          "merge-patch-style": style,
        });
        const widgetPatch = results["Validators/WidgetPatchValidator.g.cs"];
        const appearancePatch =
          results["Validators/AppearancePatchValidator.g.cs"];
        const leafPatch = results["Validators/LeafPatchValidator.g.cs"];
        const registrations = results["Validators/ValidatorsInitializer.g.cs"];

        ok(widgetPatch, `expected Widget patch validator for ${style}`);
        ok(
          appearancePatch,
          `expected nested Appearance patch validator for ${style}`,
        );
        ok(leafPatch, `expected deep Leaf patch validator for ${style}`);
        ok(registrations, `expected validator registrations for ${style}`);
        ok(
          widgetPatch.includes("Appearance.{failure.PropertyName}") &&
            widgetPatch.includes("'Appearance' must be an object."),
          `expected recursive object validation in ${style} root patch:\n${widgetPatch}`,
        );
        ok(
          appearancePatch.includes("Leaf.{failure.PropertyName}") &&
            appearancePatch.includes("'Leaf' must be an object.") &&
            appearancePatch.includes('IsNull("label")') &&
            appearancePatch.includes("TryGetValue<Theme?>"),
          `expected second-level object validation in ${style} child patch:\n${appearancePatch}`,
        );
        ok(
          leafPatch.includes("TryGetNumber(x, ") &&
            leafPatch.includes("n >= 8m") &&
            leafPatch.includes("n <= 72m"),
          `expected nested numeric bounds in ${style} deep patch:\n${leafPatch}`,
        );
        ok(
          registrations.includes("AppearancePatchValidator") &&
            registrations.includes("LeafPatchValidator"),
          `expected nested-only validators to be registered for ${style}:\n${registrations}`,
        );
        if (style === "typed") {
          ok(
            widgetPatch.includes("AppearanceMergePatchUpdate.FromJson"),
            `expected typed nested patch factory in:\n${widgetPatch}`,
          );
        }
      }
    });

    // Model/array-typed properties are always treated as nullable by the validator
    // emitter (see isNullableForValidator in src/validators.ts): a reference type can
    // hold null at runtime even when TypeSpec marks it required, so `nullable-properties:
    // false` must NOT suppress the `!`/`.When` guard for a nested-model reference.
    it("still emits the null-forgiving operator and .When guard for nested references when nullable-properties is disabled", async () => {
      const results = await emit(NESTED_MODEL_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
        "nullable-properties": false,
      });

      const postValidator = results["Validators/BookValidator.g.cs"];
      ok(
        postValidator,
        `expected Validators/BookValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        postValidator.includes(
          "RuleFor(x => x.Author!).SetValidator(authorValidator).When(x => x.Author is not null);",
        ),
        `expected the nullable scalar reference rule to survive nullable-properties: false in:\n${postValidator}`,
      );
      ok(
        postValidator.includes(
          "RuleForEach(x => x.Tags!).SetValidator(tagValidator).When(x => x.Tags is not null);",
        ),
        `expected the nullable collection reference rule to survive nullable-properties: false in:\n${postValidator}`,
      );
    });

    it("emits the null-forgiving operator and .When guards in version-aware POST validators, for both base and per-version properties", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service(#{ title: "Demo" })
        namespace Demo;

        enum Versions {
          v1_0: "v1.0",
          v2_0: "v2.0",
        }

        model Author { name: string; }
        model Tag { name: string; }

        model Book {
          id: string;
          author: Author;

          @added(Versions.v2_0)
          tags?: Tag[];
        }

        model BookPatch is MergePatchUpdate<Book>;

        interface Books {
          @route("/books")
          @post create(@body body: Book): Book;

          @route("/books/{id}")
          @patch update(@path id: string, @body body: BookPatch): Book;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );

      const postValidator = results["Validators/BookValidator.g.cs"];
      ok(
        postValidator,
        `expected Validators/BookValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        postValidator.includes("Rules for v2.0 and later"),
        `expected the version-aware POST template to be used:\n${postValidator}`,
      );
      ok(
        postValidator.includes(
          "RuleFor(x => x.Author!).SetValidator(authorValidator).When(x => x.Author is not null);",
        ),
        `expected nullable scalar reference rule among base properties in:\n${postValidator}`,
      );
      ok(
        postValidator.includes(
          "RuleForEach(x => x.Tags!).SetValidator(tagValidator).When(x => x.Tags is not null);",
        ),
        `expected nullable collection reference rule in the v2.0 property group in:\n${postValidator}`,
      );

      const patchValidator = results["Validators/BookPatchValidator.g.cs"];
      ok(
        patchValidator,
        `expected Validators/BookPatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        patchValidator.includes("Rules for v2.0 and later"),
        `expected the version-aware PATCH template to be used:\n${patchValidator}`,
      );
      ok(
        patchValidator.includes("authorPatchValidator") &&
          patchValidator.includes("tagValidator") &&
          patchValidator.includes("Rules for v2.0 and later") &&
          patchValidator.includes("JsonSerializer.Deserialize<Tag>"),
        `expected nested model and array validators in base and version-aware MergePatch groups:\n${patchValidator}`,
      );
    });

    it("keeps later-version guards on members nested inside a MergePatch model", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service namespace Demo;
        enum Versions { v1: "v1", v2: "v2" }

        model Appearance {
          @added(Versions.v2)
          @minValue(8)
          fontSize?: int32;
        }
        model Widget { appearance?: Appearance; }
        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets") interface Widgets {
          @patch update(@body body: WidgetPatch): void;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );
      const parent = results["Validators/WidgetPatchValidator.g.cs"];
      const child = results["Validators/AppearancePatchValidator.g.cs"];
      ok(
        parent && child,
        "expected parent and child version-aware patch validators",
      );
      ok(
        parent.includes("Appearance.{failure.PropertyName}"),
        `expected nested dispatch:\n${parent}`,
      );
      ok(
        child.includes("Rules for v2 and later") &&
          child.includes('IsVersionInRange("v2", null') &&
          child.includes('TryGetNumber(x, "fontSize"'),
        `expected nested later-version constraint to remain guarded:\n${child}`,
      );
    });
  });

  describe("ExtendRules custom-rule hook", () => {
    const VALIDATOR_OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    // C# forbids overriding a member in another part of the same partial class
    // (CS0111), so the hook must be a partial method rather than a virtual one.
    function assertPartialMethodHook(validator: string | undefined): void {
      ok(validator, "expected the validator file to be emitted");
      ok(
        validator.includes("    partial void ExtendRules();"),
        `expected a partial ExtendRules() declaration in:\n${validator}`,
      );
      ok(
        /^ {8}ExtendRules\(\);\r?\n {4}\}/m.test(validator),
        `expected the constructor to call ExtendRules() last in:\n${validator}`,
      );
      ok(
        !validator.includes("virtual void ExtendRules"),
        `expected no virtual ExtendRules() in:\n${validator}`,
      );
    }

    it("declares ExtendRules() as a partial method in standard POST and PATCH validators", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Widget { id: string; name: string; }
        model WidgetPatch is MergePatchUpdate<Widget>;

        interface Widgets {
          @route("/widgets")
          @post create(@body body: Widget): Widget;

          @route("/widgets/{id}")
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
        `,
        VALIDATOR_OPTIONS,
      );

      assertPartialMethodHook(results["Validators/WidgetValidator.g.cs"]);
      assertPartialMethodHook(results["Validators/WidgetPatchValidator.g.cs"]);
    });

    it("declares ExtendRules() as a partial method in version-aware POST and PATCH validators", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service(#{ title: "Demo" })
        namespace Demo;

        enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

        model Widget {
          id: string;
          @added(Versions.v2_0) @maxLength(10) label?: string;
        }
        model WidgetPatch is MergePatchUpdate<Widget>;

        interface Widgets {
          @route("/widgets")
          @post create(@body body: Widget): Widget;

          @route("/widgets/{id}")
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
        `,
        VALIDATOR_OPTIONS,
      );

      const postValidator = results["Validators/WidgetValidator.g.cs"];
      const patchValidator = results["Validators/WidgetPatchValidator.g.cs"];
      ok(
        postValidator?.includes("Rules for v2.0 and later"),
        `expected the version-aware POST template to be used:\n${postValidator}`,
      );
      ok(
        patchValidator?.includes("Rules for v2.0 and later"),
        `expected the version-aware PATCH template to be used:\n${patchValidator}`,
      );
      assertPartialMethodHook(postValidator);
      assertPartialMethodHook(patchValidator);
    });
  });

  describe("required and immutable properties of any type", () => {
    const VALIDATOR_OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    const widgetSource = (patchBody: string): string => `
      import "@typespec/http";
      using TypeSpec.Http;

      @service
      namespace Demo;

      enum Size { small, large }
      model Part { label: string; }

      model Widget {
        @visibility(Lifecycle.Read) id: string;
        name: string;
        count: int32;
        enabled: boolean;
        size: Size;
        part: Part;
        tags: string[];
        @visibility(Lifecycle.Create, Lifecycle.Read) slot: int32;
        @visibility(Lifecycle.Update, Lifecycle.Read) revision: int32;
        optCount?: int32;
        defCount: int32 = 5;
      }

      interface Widgets {
        @route("/widgets") @post create(@body body: Widget): Widget;
        @route("/widgets/{id}") @patch update(@path id: string, @body body: ${patchBody}): Widget;
      }
    `;

    /** Asserts every expected line is present in `file`. */
    function assertLines(
      file: string | undefined,
      label: string,
      lines: string[],
    ): void {
      ok(file, `expected ${label} to be emitted`);
      for (const line of lines) {
        ok(
          file.includes(line),
          `expected ${label} to contain:\n  ${line}\n\nin:\n${file}`,
        );
      }
    }

    it("requires non-string properties with NotNull() in POST validators", async () => {
      const results = await emit(
        widgetSource("MergePatchUpdate<Widget>"),
        VALIDATOR_OPTIONS,
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      assertLines(post, "WidgetValidator", [
        "RuleFor(x => x.Name).NotEmpty();",
        "RuleFor(x => x.Count).NotNull();",
        "RuleFor(x => x.Enabled).NotNull();",
        "RuleFor(x => x.Size).NotNull();",
        "RuleFor(x => x.Part).NotNull();",
        "RuleFor(x => x.Tags).NotNull();",
        "RuleFor(x => x.Slot).NotNull();",
      ]);
      for (const absent of ["x.OptCount", "x.DefCount", "x.Name).NotNull"]) {
        ok(!post.includes(absent), `expected no ${absent} rule in:\n${post}`);
      }
    });

    it("rejects an update-only property in POST validators", async () => {
      const results = await emit(
        widgetSource("MergePatchUpdate<Widget>"),
        VALIDATOR_OPTIONS,
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      assertLines(post, "WidgetValidator", [
        "// Revision can only be set by an update and must not be set on creation",
        "RuleFor(x => x.Revision).Null();",
        "// Id is read-only and must not be set on creation",
      ]);
      ok(
        !post.includes("x.Revision).NotNull"),
        `expected the update-only property not to be required in:\n${post}`,
      );
    });

    it("rejects explicit null for required properties and rejects immutable ones in MergePatch validators", async () => {
      const results = await emit(
        widgetSource("MergePatchUpdate<Widget>"),
        VALIDATOR_OPTIONS,
      );
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      for (const name of [
        "Name",
        "Count",
        "Enabled",
        "Size",
        "Part",
        "Tags",
        "Revision",
      ]) {
        assertLines(patch, "WidgetPatchValidator", [
          `.Must(x => !x.IsNull("${wireName(name)}"))`,
          `.WithMessage("'${name}' is required and cannot be null.");`,
        ]);
      }
      assertLines(patch, "WidgetPatchValidator", [
        "// Slot cannot be changed after creation",
        '.Must(x => !x.IsDefined("slot"))',
        `.WithMessage("'Slot' cannot be changed after creation.");`,
        `.WithMessage("'Id' is read-only and cannot be modified.");`,
      ]);
      for (const absent of [
        'IsNull("optCount")',
        'IsNull("defCount")',
        'IsNull("slot")',
        'IsNull("id")',
      ]) {
        ok(!patch.includes(absent), `expected no ${absent} rule in:\n${patch}`);
      }
    });

    it("rejects immutable properties in plain PATCH validators when they can be null", async () => {
      const results = await emit(widgetSource("Widget"), VALIDATOR_OPTIONS);
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      assertLines(patch, "WidgetPatchValidator", [
        "// Slot cannot be changed after creation and must not be supplied",
        "RuleFor(x => x.Slot).Null();",
      ]);
      ok(
        !patch.includes("NotNull()"),
        `a plain PATCH body cannot distinguish omitted from null, so nothing is required:\n${patch}`,
      );
    });

    it("skips rules that cannot be checked on non-nullable value types", async () => {
      const results = await emit(widgetSource("Widget"), {
        ...VALIDATOR_OPTIONS,
        "nullable-properties": false,
      });
      const post = results["Validators/WidgetValidator.g.cs"];
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      assertLines(post, "WidgetValidator", [
        "RuleFor(x => x.Part).NotNull();",
        "RuleFor(x => x.Tags).NotNull();",
      ]);
      for (const absent of [
        "x.Count)",
        "x.Enabled)",
        "x.Slot)",
        "x.Revision)",
      ]) {
        ok(
          !post.includes(absent),
          `expected no ${absent} rule in POST:\n${post}`,
        );
      }
      ok(
        !patch.includes("x.Slot)"),
        `expected no Slot rule in PATCH:\n${patch}`,
      );
    });

    it("does not reject null for required properties whose type explicitly allows it", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Part { label: string; }

        model Widget {
          note: string | null;
          count: int32 | null;
          part: Part | null;
          mode: "fast" | "slow" | null;
          name: string;
        }

        interface Widgets {
          @route("/widgets") @post create(@body body: Widget): Widget;
          @route("/widgets") @patch update(@body body: MergePatchUpdate<Widget>): Widget;
        }
        `,
        VALIDATOR_OPTIONS,
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      assertLines(post, "WidgetValidator", [
        "RuleFor(x => x.Name).NotEmpty();",
      ]);
      assertLines(patch, "WidgetPatchValidator", [
        '.Must(x => !x.IsNull("name"))',
      ]);
      for (const name of ["Note", "Count", "Part", "Mode"]) {
        ok(
          !post.includes(`x.${name}).NotNull()`) &&
            !post.includes(`x.${name}).NotEmpty()`),
          `expected no non-null rule for ${name} in:\n${post}`,
        );
        ok(
          !patch.includes(`IsNull("${wireName(name)}"))\n`) &&
            !patch.includes(`.Must(x => !x.IsNull("${wireName(name)}"))`),
          `expected no reject-null rule for ${name} in:\n${patch}`,
        );
      }
    });

    // TypeSpec cannot version a property's visibility, so a lifecycle-restricted
    // property added in v2 is never writable in this phase in any version.
    // The single model class still declares it, so the rejection compiles, and
    // keeping it stops an older-version client from slipping the value through.
    for (const strategy of ["earliest", "per-version"] as const) {
      it(`keeps lifecycle rejections for properties added in later versions (${strategy})`, async () => {
        const results = await emit(
          `
          import "@typespec/http";
          import "@typespec/versioning";
          using TypeSpec.Http;
          using TypeSpec.Versioning;

          @versioned(Versions)
          @service(#{ title: "Demo" })
          namespace Demo;

          enum Versions { v1, v2 }

          model Widget {
            name: string;
            @added(Versions.v2) @visibility(Lifecycle.Update, Lifecycle.Read) revision?: int32;
            @added(Versions.v2) @visibility(Lifecycle.Create, Lifecycle.Read) slot?: int32;
          }

          interface Widgets {
            @route("/widgets") @post create(@body body: Widget): Widget;
            @route("/widgets") @patch update(@body body: MergePatchUpdate<Widget>): Widget;
          }
          `,
          { ...VALIDATOR_OPTIONS, "validators-version-strategy": strategy },
        );
        const dir = strategy === "per-version" ? "Validators/v1" : "Validators";
        assertLines(
          results[`${dir}/WidgetValidator.g.cs`],
          `${dir}/WidgetValidator`,
          [
            "// Revision can only be set by an update and must not be set on creation",
            "RuleFor(x => x.Revision).Null();",
          ],
        );
        assertLines(
          results[`${dir}/WidgetPatchValidator.g.cs`],
          `${dir}/WidgetPatchValidator`,
          [
            '.Must(x => !x.IsDefined("slot"))',
            `.WithMessage("'Slot' cannot be changed after creation.");`,
          ],
        );
      });
    }

    it("applies the same rules in version-aware validators, in base and per-version blocks", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service(#{ title: "Demo" })
        namespace Demo;

        enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

        model Widget {
          @visibility(Lifecycle.Read) id: string;
          count: int32;
          @visibility(Lifecycle.Create, Lifecycle.Read) slot: int32;
          @added(Versions.v2_0) weight: float64;
        }

        interface Widgets {
          @route("/widgets") @post create(@body body: Widget): Widget;
          @route("/widgets/{id}") @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
        }
        `,
        VALIDATOR_OPTIONS,
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      assertLines(post, "WidgetValidator", [
        "Rules for v2.0 and later",
        "RuleFor(x => x.Count).NotNull();",
        "RuleFor(x => x.Weight).NotNull();",
      ]);
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      assertLines(patch, "WidgetPatchValidator", [
        "Rules for v2.0 and later",
        '.Must(x => !x.IsNull("count"))',
        '.Must(x => !x.IsNull("weight"))',
        `.WithMessage("'Slot' cannot be changed after creation.");`,
      ]);
      for (const [file, label, base, versioned] of [
        [post, "WidgetValidator", "x.Count).NotNull", "x.Weight).NotNull"],
        [patch, "WidgetPatchValidator", 'IsNull("count")', 'IsNull("weight")'],
      ] as const) {
        const groupStart = file.indexOf("Rules for v2.0 and later");
        ok(
          file.indexOf(base) < groupStart &&
            file.indexOf(versioned) > groupStart,
          `expected ${base} in the base block and ${versioned} in the v2.0 block of ${label}:\n${file}`,
        );
      }
    });
  });

  describe("plain (non-MergePatch) PATCH bodies", () => {
    // `IsDefined`/`GetString`/`IsNull`/`TryGetValue` are members of MergePatch<T> only.
    // A plain model used as a PATCH body is an ordinary POCO, so rules must use typed
    // property access guarded on null instead, or the generated C# does not compile.
    const MERGE_PATCH_ONLY_APIS = [
      "GetString(",
      "IsDefined(",
      "IsNull(",
      "TryGetValue<",
    ];

    const PLAIN_PATCH_SOURCE = `
      import "@typespec/http";
      using TypeSpec.Http;

      @service
      namespace Demo;

      enum Channel { Web: "web", App: "app" }

      model Targeting { region: string; }
      model Segment { code: string; }

      model QuotaGroup { id: string; }

      model QuotaGroupUpdate {
        @minValue(0)
        target: int32;

        @maxValue(100)
        ceiling: int32;

        @minLength(2)
        @maxLength(50)
        name?: string;

        @pattern("^[a-z]+$")
        slug?: string;

        @format("email")
        owner?: string;

        channel?: Channel;

        targeting: Targeting;
        segments: Segment[];

        @visibility(Lifecycle.Read)
        createdAt?: utcDateTime;
      }

      @route("/quota-groups/{id}")
      interface QuotaGroups {
        @patch update(@path id: string, @body body: QuotaGroupUpdate): QuotaGroup;
      }
    `;

    it("emits typed, null-guarded rules instead of MergePatch-only APIs", async () => {
      const results = await emit(PLAIN_PATCH_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });

      const validator =
        results["Validators/QuotaGroupUpdatePatchValidator.g.cs"];
      ok(
        validator,
        `expected Validators/QuotaGroupUpdatePatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );

      const leaked = MERGE_PATCH_ONLY_APIS.filter((api) =>
        validator.includes(api),
      );
      strictEqual(
        leaked.join(", "),
        "",
        `MergePatch-only APIs emitted against a plain POCO body:\n${validator}`,
      );

      for (const expected of [
        "RuleFor(x => x.Target).GreaterThanOrEqualTo(0).When(x => x.Target is not null);",
        "RuleFor(x => x.Ceiling).LessThanOrEqualTo(100).When(x => x.Ceiling is not null);",
        "RuleFor(x => x.Name).MinimumLength(2).When(x => x.Name is not null);",
        "RuleFor(x => x.Name).MaximumLength(50).When(x => x.Name is not null);",
        `RuleFor(x => x.Slug).Must(value => IsMatch(_slugPattern, value)).WithMessage("'{PropertyName}' is not in the correct format.").When(x => x.Slug is not null);`,
        "RuleFor(x => x.Owner).EmailAddress().When(x => x.Owner is not null);",
        "RuleFor(x => x.Channel).IsInEnum().When(x => x.Channel is not null);",
      ]) {
        ok(
          validator.includes(expected),
          `expected typed rule ${expected} in:\n${validator}`,
        );
      }
    });

    it("emits typed nested-model rules for scalar and collection references", async () => {
      const results = await emit(PLAIN_PATCH_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });

      const validator =
        results["Validators/QuotaGroupUpdatePatchValidator.g.cs"];
      ok(validator, "expected QuotaGroupUpdatePatchValidator.g.cs");
      ok(
        validator.includes(
          "RuleFor(x => x.Targeting!).SetValidator(targetingValidator).When(x => x.Targeting is not null);",
        ),
        `expected typed nested scalar reference rule in:\n${validator}`,
      );
      ok(
        validator.includes(
          "RuleForEach(x => x.Segments!).SetValidator(segmentValidator).When(x => x.Segments is not null);",
        ),
        `expected typed nested collection reference rule in:\n${validator}`,
      );
      ok(
        validator.includes("AbstractValidator<Targeting> targetingValidator") &&
          validator.includes("AbstractValidator<Segment> segmentValidator"),
        `expected child validators to be injected in:\n${validator}`,
      );
    });

    it("rejects a supplied value for read-only properties", async () => {
      const results = await emit(PLAIN_PATCH_SOURCE, {
        "emit-validators": true,
        "emit-controllers": false,
        "emit-services": false,
        "emit-interfaces": false,
      });

      const validator =
        results["Validators/QuotaGroupUpdatePatchValidator.g.cs"];
      ok(validator, "expected QuotaGroupUpdatePatchValidator.g.cs");
      ok(
        validator.includes("RuleFor(x => x.CreatedAt).Null();"),
        `expected a Null() rule for the read-only property in:\n${validator}`,
      );
    });

    it("emits typed rules in both the base and per-version blocks of the version-aware template", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;

        @versioned(Versions)
        @service(#{ title: "Demo" })
        namespace Demo;

        enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

        model Targeting { region: string; }

        model WidgetUpdate {
          @minValue(0)
          target: int32;

          targeting: Targeting;

          @added(Versions.v2_0)
          @maxValue(100)
          ceiling?: int32;

          @added(Versions.v2_0)
          extra?: Targeting;
        }

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: WidgetUpdate): WidgetUpdate;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );

      const validator = results["Validators/WidgetUpdatePatchValidator.g.cs"];
      ok(
        validator,
        `expected Validators/WidgetUpdatePatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        validator.includes("Rules for v2.0 and later"),
        `expected the version-aware PATCH template to be used:\n${validator}`,
      );

      const leaked = MERGE_PATCH_ONLY_APIS.filter((api) =>
        validator.includes(api),
      );
      strictEqual(
        leaked.join(", "),
        "",
        `MergePatch-only APIs emitted against a plain POCO body:\n${validator}`,
      );

      // Base block.
      ok(
        validator.includes(
          "RuleFor(x => x.Target).GreaterThanOrEqualTo(0).When(x => x.Target is not null);",
        ) &&
          validator.includes(
            "RuleFor(x => x.Targeting!).SetValidator(targetingValidator).When(x => x.Targeting is not null);",
          ),
        `expected typed base-property rules in:\n${validator}`,
      );
      // Per-version block.
      ok(
        validator.includes(
          "RuleFor(x => x.Ceiling).LessThanOrEqualTo(100).When(x => x.Ceiling is not null);",
        ) &&
          validator.includes(
            "RuleFor(x => x.Extra!).SetValidator(targetingValidator).When(x => x.Extra is not null);",
          ),
        `expected typed per-version rules in:\n${validator}`,
      );
    });

    it("leaves MergePatch bodies on the string-keyed rule shape", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;

        model Widget {
          @minValue(0)
          target: int32;

          @minLength(2)
          name: string;
        }

        model WidgetPatch is MergePatchUpdate<Widget>;

        @route("/widgets/{id}")
        interface Widgets {
          @patch update(@path id: string, @body body: WidgetPatch): Widget;
        }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );

      const validator = results["Validators/WidgetPatchValidator.g.cs"];
      ok(
        validator,
        `expected Validators/WidgetPatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        validator.includes("AbstractValidator<MergePatch<Widget>>"),
        `expected the validator to target the MergePatch body in:\n${validator}`,
      );
      ok(
        validator.includes(
          '.When(x => x.IsDefined("target") && !x.IsNull("target"))',
        ) && validator.includes('x.GetString("name")'),
        `expected MergePatch bodies to keep the string-keyed rule shape in:\n${validator}`,
      );
      ok(
        !validator.includes("RuleFor(x => x.Target)"),
        `did not expect typed property access against a MergePatch body in:\n${validator}`,
      );
    });
  });

  describe("nested PATCH validator discovery", () => {
    const OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    it("dispatches nested polymorphic patches across helper styles and version strategies", async () => {
      const source = `
        import "@typespec/http";
        import "@typespec/versioning";
        import "@massivescale/tsp-aspnetcore-api";
        using TypeSpec.Http;
        using TypeSpec.Versioning;
        using MassiveScale.AspNetCoreApi;
        @service @versioned(Versions) namespace Demo;
        enum Versions { v1: "v1", v2: "v2" }
        enum Kind { dog: "canine" }
        @discriminator("kind")
        model Pet { @encodedName("application/json", "$type") kind: Kind; name?: string; }
        model Mammal extends Pet {}
        model Details { @minValue(1) count?: int32; }
        @serverName("Canine")
        model Dog extends Mammal {
          kind: Kind.dog;
          @added(Versions.v2) @minValue(2) teeth?: int32;
          details?: Details;
          friend?: Pet;
        }
        model Owner { pet?: Pet; catalog?: Record<Pet>; }
        @route("/owners") @patch op update(@body body: MergePatchUpdate<Owner>): void;
      `;
      for (const style of ["generic", "typed"]) {
        for (const strategy of [
          "earliest",
          "latest",
          "per-version",
          "version-aware",
        ]) {
          const [results, diagnostics] = await emitWithDiagnostics(source, {
            ...OPTIONS,
            validators: "patch",
            "merge-patch-style": style,
            "validators-version-strategy": strategy,
            "fully-qualified-types": true,
            "models-namespace": "Demo.Models",
            "helpers-namespace": "Demo.Helpers",
          });
          strictEqual(
            diagnostics.length,
            strategy === "latest" ? 1 : 0,
            describeDiagnostics(diagnostics),
          );
          if (strategy === "latest") {
            strictEqual(
              diagnostics[0].code,
              "@massivescale/tsp-aspnetcore-api/version-strategy-breaking",
            );
          }
          const directories =
            strategy === "per-version" ? ["v1/", "v2/"] : [""];
          for (const directory of directories) {
            const base =
              results[`Validators/${directory}PetPatchValidator.g.cs`];
            const derived =
              results[`Validators/${directory}CaninePatchValidator.g.cs`];
            const owner =
              results[`Validators/${directory}OwnerPatchValidator.g.cs`];
            const patchType =
              style === "generic"
                ? "Demo.Helpers.MergePatch<Demo.Models.Canine>"
                : "Demo.Models.CanineMergePatchUpdate";
            ok(
              base.includes(
                `AbstractValidator<${patchType}> caninePatchValidator`,
              ),
              base,
            );
            ok(base.includes('case "canine":'), base);
            ok(
              base.includes(
                `new ${patchType} { Properties = patch.Properties }`,
              ),
              base,
            );
            ok(
              base.includes('When(patch => !patch.IsDefined("$type"), () =>'),
              base,
            );
            ok(owner.includes('if (!nestedPatch.IsDefined("$type"))'), owner);
            ok(owner.includes("The discriminator is required."), owner);
            ok(derived.includes("detailsPatchValidator"), derived);
            ok(results[`Validators/${directory}DetailsPatchValidator.g.cs`]);
            if (
              strategy === "version-aware" ||
              directory === "v2/" ||
              strategy === "latest"
            ) {
              ok(derived.includes('.When(x => x.IsDefined("teeth")'), derived);
            } else {
              ok(!derived.includes('x.IsDefined("teeth")'), derived);
            }
          }
        }
      }
    });

    it("emits nested MergePatch validators for references declared only on a derived type", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;
        model Owner { name: string; }
        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; owner?: Owner; }
        model PetPatch is MergePatchUpdate<Pet>;
        @route("/pets") interface Pets {
          @patch update(@body body: PetPatch): void;
        }
        `,
        OPTIONS,
      );
      const dog = results["Validators/DogPatchValidator.g.cs"];
      ok(
        dog.includes(
          "AbstractValidator<MergePatch<Owner>> ownerPatchValidator",
        ),
        `expected Dog to inject the Owner patch validator:\n${dog}`,
      );
      ok(
        results["Validators/OwnerPatchValidator.g.cs"],
        `expected an Owner patch validator, got: ${Object.keys(results).join(", ")}`,
      );
      const registrations = results["Validators/ValidatorsInitializer.g.cs"];
      ok(
        registrations.includes(
          "AddSingleton<AbstractValidator<MergePatch<Owner>>>(sp => sp.GetRequiredService<OwnerPatchValidator>())",
        ),
        `expected the Owner patch validator to be registered:\n${registrations}`,
      );
    });

    it("emits the derived-type validators that a nested discriminated base injects", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;
        @discriminator("kind")
        model Gadget { kind: string; }
        model Gear extends Gadget { kind: "gear"; teeth?: int32; }
        model Widget { gadgets?: Gadget[]; }
        model WidgetPatch is MergePatchUpdate<Widget>;
        @route("/widgets") interface Widgets {
          @patch update(@body body: WidgetPatch): void;
        }
        `,
        OPTIONS,
      );
      ok(
        results["Validators/GadgetValidator.g.cs"].includes(
          "AbstractValidator<Gear> gearValidator",
        ),
        "expected the base validator to inject the Gear validator",
      );
      ok(
        results["Validators/GearValidator.g.cs"],
        `expected a Gear validator, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        results["Validators/ValidatorsInitializer.g.cs"].includes(
          "AddSingleton<GearValidator>()",
        ),
        "expected the Gear validator to be registered",
      );
    });

    const PLAIN_AND_NESTED_SOURCE = (
      routeOrder: "plain-first" | "merge-first",
    ) => {
      const plain = `@route("/addresses") interface Addresses { @patch update(@body body: Address): void; }`;
      const merge = `@route("/customers") interface Customers { @patch update(@body body: CustomerPatch): void; }`;
      return `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;
        model Address { @maxLength(40) street: string; }
        model Customer { address?: Address; }
        model CustomerPatch is MergePatchUpdate<Customer>;
        ${routeOrder === "plain-first" ? `${plain}\n${merge}` : `${merge}\n${plain}`}
      `;
    };

    it("emits both a plain and a MergePatch validator when a model needs both", async () => {
      const results = await emit(
        PLAIN_AND_NESTED_SOURCE("plain-first"),
        OPTIONS,
      );
      const plain = results["Validators/AddressPatchValidator.g.cs"];
      const merge = results["Validators/AddressMergePatchValidator.g.cs"];
      ok(
        plain.includes(
          "public partial class AddressPatchValidator : AbstractValidator<Address>",
        ) && plain.includes("RuleFor(x => x.Street)"),
        `expected the plain PATCH validator to keep its name and body type:\n${plain}`,
      );
      ok(
        merge.includes(
          "public partial class AddressMergePatchValidator : AbstractValidator<MergePatch<Address>>",
        ) &&
          merge.includes("public AddressMergePatchValidator(") &&
          merge.includes('GetString("street")'),
        `expected a separate MergePatch validator:\n${merge}`,
      );
      const registrations = results["Validators/ValidatorsInitializer.g.cs"];
      ok(
        registrations.includes(
          "AddSingleton<AbstractValidator<Address>>(sp => sp.GetRequiredService<AddressPatchValidator>())",
        ) &&
          registrations.includes(
            "AddSingleton<AbstractValidator<MergePatch<Address>>>(sp => sp.GetRequiredService<AddressMergePatchValidator>())",
          ),
        `expected both validators to be registered:\n${registrations}`,
      );
    });

    it("gives the same output whatever order the routes are declared in", async () => {
      const first = await emit(PLAIN_AND_NESTED_SOURCE("plain-first"), OPTIONS);
      const second = await emit(
        PLAIN_AND_NESTED_SOURCE("merge-first"),
        OPTIONS,
      );
      const validatorFiles = (files: Record<string, string>) =>
        Object.keys(files)
          .filter((path) => path.startsWith("Validators/"))
          .sort();
      strictEqual(
        JSON.stringify(validatorFiles(first)),
        JSON.stringify(validatorFiles(second)),
      );
      for (const path of validatorFiles(first)) {
        strictEqual(first[path], second[path], `expected ${path} to match`);
      }
    });

    it("keeps a single PatchValidator when a model is only a MergePatch body", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;
        model Address { street: string; }
        model Customer { address?: Address; }
        model CustomerPatch is MergePatchUpdate<Customer>;
        @route("/customers") interface Customers { @patch update(@body body: CustomerPatch): void; }
        `,
        OPTIONS,
      );
      ok(results["Validators/AddressPatchValidator.g.cs"]);
      ok(!results["Validators/AddressMergePatchValidator.g.cs"]);
    });
  });

  describe("recursive and cyclic validators", () => {
    const OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    function source(models: string, routes?: string): string {
      return `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;
        ${models}
        model RootPatch is MergePatchUpdate<Root>;
        ${
          routes ??
          `@route("/roots") interface Roots {
            @post create(@body body: Root): void;
            @patch update(@body body: RootPatch): void;
          }`
        }
      `;
    }

    /** Returns the parameter list of the first public constructor in `file`. */
    function constructorParameters(file: string, className: string): string {
      const start = file.indexOf(`public ${className}(`);
      ok(start >= 0, `expected a ${className} constructor:\n${file}`);
      return file.slice(
        start + `public ${className}(`.length,
        file.indexOf(")", start),
      );
    }

    it("uses the validator itself for a model that references itself", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(
        source(
          `model Root { name?: string; child?: Root; children?: Root[]; }`,
        ),
        OPTIONS,
      );
      strictEqual(diagnostics.length, 0, describeDiagnostics(diagnostics));

      const post = results["Validators/RootValidator.g.cs"];
      strictEqual(constructorParameters(post, "RootValidator"), "");
      ok(
        post.includes(
          "RuleFor(x => x.Child!).SetValidator(this).When(x => x.Child is not null);",
        ) &&
          post.includes(
            "RuleForEach(x => x.Children!).SetValidator(this).When(x => x.Children is not null);",
          ),
        post,
      );

      const patch = results["Validators/RootPatchValidator.g.cs"];
      strictEqual(
        constructorParameters(patch, "RootPatchValidator"),
        "Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Mvc.JsonOptions> jsonOptions, AbstractValidator<Root> rootValidator",
      );
      ok(
        patch.includes("var nestedResult = this.Validate(nestedPatch);") &&
          patch.includes(
            "var nestedResult = rootValidator.Validate(nestedModel);",
          ),
        patch,
      );
    });

    it("resolves the edge that closes a longer loop lazily", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(
        source(`
          model Root { branch?: Branch; }
          model Branch { leaf?: Leaf; }
          model Leaf { root?: Root; }
        `),
        OPTIONS,
      );
      strictEqual(diagnostics.length, 0, describeDiagnostics(diagnostics));

      strictEqual(
        constructorParameters(
          results["Validators/RootValidator.g.cs"],
          "RootValidator",
        ),
        "AbstractValidator<Branch> branchValidator",
      );
      const leaf = results["Validators/LeafValidator.g.cs"];
      strictEqual(
        constructorParameters(leaf, "LeafValidator"),
        "System.IServiceProvider serviceProvider",
      );
      ok(
        leaf.includes("using Microsoft.Extensions.DependencyInjection;") &&
          leaf.includes(
            "RuleFor(x => x.Root!).SetValidator(_ => serviceProvider.GetRequiredService<AbstractValidator<Root>>()).When(x => x.Root is not null);",
          ),
        leaf,
      );

      const leafPatch = results["Validators/LeafPatchValidator.g.cs"];
      ok(
        constructorParameters(leafPatch, "LeafPatchValidator").endsWith(
          "System.IServiceProvider serviceProvider",
        ) &&
          leafPatch.includes(
            "var nestedResult = serviceProvider.GetRequiredService<AbstractValidator<MergePatch<Root>>>().Validate(nestedPatch);",
          ),
        leafPatch,
      );
    });

    it("breaks the loop between a discriminated base and a derived type that references it", async () => {
      const results = await emit(
        source(
          `
          @discriminator("kind")
          model Root { kind: string; name?: string; friend?: Root; }
          model Cat extends Root { kind: "cat"; purrs?: boolean; }
          `,
        ),
        OPTIONS,
      );
      const root = results["Validators/RootValidator.g.cs"];
      strictEqual(
        constructorParameters(root, "RootValidator"),
        "AbstractValidator<Cat> catValidator",
      );
      ok(root.includes("SetValidator(this)"), root);

      const cat = results["Validators/CatValidator.g.cs"];
      strictEqual(
        constructorParameters(cat, "CatValidator"),
        "System.IServiceProvider serviceProvider",
      );
      ok(
        cat.includes(
          "SetValidator(_ => serviceProvider.GetRequiredService<AbstractValidator<Root>>())",
        ),
        cat,
      );
    });

    it("emits no recursion diagnostic for any loop shape", async () => {
      for (const models of [
        `model Root { child?: Root; }`,
        `model Root { children?: Root[]; }`,
        `model Root { @visibility(Lifecycle.Read) parent?: Root; }`,
        `model Root { a?: A; } model A { b?: B; } model B { root?: Root; }`,
      ]) {
        const [, diagnostics] = await emitWithDiagnostics(
          source(models),
          OPTIONS,
        );
        strictEqual(
          diagnostics.length,
          0,
          `${models}\n${describeDiagnostics(diagnostics)}`,
        );
      }
    });

    it("does not treat a model reached through two different paths as a loop", async () => {
      const results = await emit(
        source(`
          model Shared { name?: string; }
          model Left { shared?: Shared; }
          model Right { shared?: Shared; }
          model Root { left?: Left; right?: Right; }
        `),
        OPTIONS,
      );
      for (const file of Object.values(results)) {
        ok(!file.includes("serviceProvider"), file);
      }
    });
  });

  describe("version-aware nested MergePatch rules", () => {
    it("indents nested rules inside version groups and injects JsonOptions after the HTTP context", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using TypeSpec.Http;
        using TypeSpec.Versioning;
        @versioned(Versions)
        @service namespace Demo;
        enum Versions { v1: "v1", v2: "v2" }
        model Tag { name: string; }
        model Widget {
          name?: string;
          @added(Versions.v2) tags?: Tag[];
        }
        model WidgetPatch is MergePatchUpdate<Widget>;
        @route("/widgets") interface Widgets { @patch update(@body body: WidgetPatch): void; }
        `,
        {
          "emit-validators": true,
          "emit-controllers": false,
          "emit-services": false,
          "emit-interfaces": false,
        },
      );
      const validator = results["Validators/WidgetPatchValidator.g.cs"];
      ok(
        validator.includes(
          "public WidgetPatchValidator(IHttpContextAccessor httpContextAccessor, Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Mvc.JsonOptions> jsonOptions, AbstractValidator<Tag> tagValidator)",
        ),
        `expected JsonOptions after the HTTP context accessor:\n${validator}`,
      );
      const lines = validator.split(/\r?\n/);
      const groupStart = lines.findIndex((line) =>
        line.includes("Rules for v2 and later"),
      );
      const nested = lines.findIndex(
        (line, index) =>
          index > groupStart && line.includes(".Custom((patch, context) =>"),
      );
      ok(
        nested > groupStart &&
          lines[nested].startsWith("            this.RuleFor"),
        `expected the nested rule at the 12-space group indent:\n${validator}`,
      );
    });
  });
  describe("wire names and escaping", () => {
    const OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    it("looks MergePatch properties up by their wire name, not the C# name", async () => {
      const results = await emit(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using TypeSpec.Http;

        @service
        namespace Demo;
        model Widget {
          @serverName("DisplayName") @maxLength(10) name: string;
          @encodedName("application/json", "color_code") @maxLength(5) colorCode?: string;
        }

        @route("/widgets")
        interface Widgets {
          @patch update(@body body: MergePatchUpdate<Widget>): Widget;
        }
        `,
        OPTIONS,
      );

      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      ok(
        patch,
        `expected a patch validator, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        patch.includes('IsDefined("name")') &&
          patch.includes('IsDefined("color_code")'),
        `expected wire-name lookups in:\n${patch}`,
      );
      ok(
        !patch.includes('IsDefined("DisplayName")') &&
          !patch.includes('IsDefined("ColorCode")'),
        `expected no C#-name lookups in:\n${patch}`,
      );
    });

    it("reads enum and numeric MergePatch values by their wire name", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;
        enum Color { red, blue }
        model Widget {
          pet_color?: Color;
          @minValue(1) pet_count?: int32;
        }

        @route("/widgets")
        interface Widgets {
          @patch update(@body body: MergePatchUpdate<Widget>): Widget;
        }
        `,
        OPTIONS,
      );

      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      ok(
        patch,
        `expected a patch validator, got ${Object.keys(results).join(", ")}`,
      );
      ok(
        patch.includes('x.TryGetValue<Color?>("pet_color", out _)') &&
          patch.includes('TryGetNumber(x, "pet_count", out var n)'),
        `expected wire-name value reads in:\n${patch}`,
      );
      ok(
        !patch.includes('TryGetValue<Color?>("PetColor"') &&
          !patch.includes('TryGetNumber(x, "PetCount"'),
        `expected no C#-name value reads in:\n${patch}`,
      );
    });

    it("writes @pattern verbatim, with quotes doubled for the verbatim string", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;

        @service
        namespace Demo;
        model Widget { @pattern("^[a-z]+=\\"<x>\\"&$") code: string; }

        @route("/widgets")
        interface Widgets {
          @post create(@body body: Widget): Widget;
        }
        `,
        OPTIONS,
      );

      const post = results["Validators/WidgetValidator.g.cs"];
      ok(
        post.includes('new(@"^[a-z]+=""<x>""&$"'),
        `expected the raw pattern in:\n${post}`,
      );
      ok(
        !/&#x3D;|&quot;|&lt;|&amp;/.test(post),
        `expected no HTML entities in:\n${post}`,
      );
    });
  });

  describe("pre-release regressions", () => {
    const OPTIONS = {
      "emit-validators": true,
      "emit-controllers": false,
      "emit-services": false,
      "emit-interfaces": false,
    };

    /** Asserts every expected snippet is present in `file`. */
    function expectAll(
      file: string | undefined,
      label: string,
      snippets: string[],
    ): void {
      ok(file, `expected ${label} to be emitted`);
      for (const snippet of snippets) {
        ok(
          file.includes(snippet),
          `expected ${label} to contain:\n  ${snippet}\n\nin:\n${file}`,
        );
      }
    }

    /** Asserts no forbidden snippet is present in `file`. */
    function expectNone(
      file: string | undefined,
      label: string,
      snippets: string[],
    ): void {
      ok(file, `expected ${label} to be emitted`);
      for (const snippet of snippets) {
        ok(
          !file.includes(snippet),
          `expected ${label} not to contain:\n  ${snippet}\n\nin:\n${file}`,
        );
      }
    }

    const versionedSource = (models: string, routes: string) => `
      import "@typespec/http";
      import "@typespec/versioning";
      using TypeSpec.Http;
      using TypeSpec.Versioning;

      @versioned(Versions)
      @service(#{ title: "Demo" })
      namespace Demo;

      enum Versions { v1: "v1", v2: "v2", v3: "v3" }

      ${models}

      ${routes}
    `;

    it("does not reject a read-only or update-only property that has a default value", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Pet {
          name: string;
          @visibility(Lifecycle.Read, Lifecycle.Update) status: "available" | "sold" = "available";
          @visibility(Lifecycle.Read) version: int32 = 1;
          @visibility(Lifecycle.Read, Lifecycle.Create) code: string = "x";
          @visibility(Lifecycle.Read) id?: string;
        }

        interface Pets {
          @route("/pets") @post create(@body body: Pet): Pet;
          @route("/pets/{id}") @patch update(@path id: string, @body body: Pet): Pet;
          @route("/pets/{id}/merge") @patch merge(@path id: string, @body body: MergePatchUpdate<Pet>): Pet;
        }
        `,
        OPTIONS,
      );
      const post = results["Validators/PetValidator.g.cs"];
      expectNone(post, "PetValidator", [
        "RuleFor(x => x.Status).Null()",
        "RuleFor(x => x.Version).Null()",
      ]);
      expectAll(post, "PetValidator", ["RuleFor(x => x.Id).Null();"]);
      expectNone(
        results["Validators/PetPatchValidator.g.cs"],
        "PetPatchValidator",
        ["RuleFor(x => x.Code).Null()", "RuleFor(x => x.Version).Null()"],
      );
      expectAll(
        results["Validators/PetMergePatchValidator.g.cs"],
        "PetMergePatchValidator",
        [
          '.Must(x => !x.IsDefined("code"))',
          '.Must(x => !x.IsDefined("version"))',
        ],
      );
    });

    it("writes numeric bounds as literals of the property's type", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Measure {
          @minValue(0.5) @maxValue(99.5) price?: decimal;
          @minValue(0.5) @maxValue(2.5) ratio?: float32;
          @minValue(1) @maxValue(9) count?: int32;
          @minValueExclusive(0) @maxValueExclusive(10) open?: int32;
          @minValue(1) @maxValue(100) small?: int16;
          @minValue(0) @maxValue(7) unsigned?: uint32;
          @minValue(0) @maxValue(5000000000) big?: int64;
          @minValue(0.25) weight?: float64;
        }

        interface Measures {
          @route("/m") @post create(@body body: Measure): void;
          @route("/m") @patch update(@body body: MergePatchUpdate<Measure>): void;
        }
        `,
        OPTIONS,
      );
      expectAll(
        results["Validators/MeasureValidator.g.cs"],
        "MeasureValidator",
        [
          "RuleFor(x => x.Price).GreaterThanOrEqualTo(0.5m);",
          "RuleFor(x => x.Price).LessThanOrEqualTo(99.5m);",
          "RuleFor(x => x.Ratio).GreaterThanOrEqualTo(0.5f);",
          "RuleFor(x => x.Count).GreaterThanOrEqualTo(1);",
          "RuleFor(x => x.Count).LessThanOrEqualTo(9);",
          "RuleFor(x => x.Open).GreaterThan(0);",
          "RuleFor(x => x.Open).LessThan(10);",
          "RuleFor(x => x.Small).GreaterThanOrEqualTo((short)1);",
          "RuleFor(x => x.Unsigned).GreaterThanOrEqualTo(0u);",
          "RuleFor(x => x.Unsigned).LessThanOrEqualTo(7u);",
          "RuleFor(x => x.Big).LessThanOrEqualTo(5000000000L);",
          "RuleFor(x => x.Weight).GreaterThanOrEqualTo(0.25d);",
        ],
      );
      expectAll(
        results["Validators/MeasurePatchValidator.g.cs"],
        "MeasurePatchValidator",
        [
          '.Must(x => TryGetNumber(x, "count", out var n) && n >= 1m)',
          '.Must(x => TryGetNumber(x, "price", out var n) && n <= 99.5m)',
          '.Must(x => TryGetNumber(x, "open", out var n) && n > 0m)',
          "private static bool TryGetNumber(MergePatch<Measure> patch, string name, out decimal value)",
          "element.ValueKind != System.Text.Json.JsonValueKind.Number",
          "element.TryGetDecimal(out value)",
        ],
      );
      expectNone(
        results["Validators/MeasurePatchValidator.g.cs"],
        "MeasurePatchValidator",
        ["NumberStyles", "decimal.TryParse"],
      );
    });

    it("injects a derived-type validator once when the base also references that type", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        @discriminator("kind")
        model Pet { kind: string; best?: Dog; }
        model Dog extends Pet { kind: "dog"; barks?: boolean; }

        @route("/pets") interface Pets { @post create(@body body: Pet): void; }
        `,
        { ...OPTIONS, validators: "post" },
      );
      const pet = results["Validators/PetValidator.g.cs"];
      expectAll(pet, "PetValidator", [
        "public PetValidator(AbstractValidator<Dog> dogValidator)",
        "RuleFor(x => x.Best!).SetValidator(dogValidator).When(x => x.Best is not null);",
        "v.Add<Dog>(dogValidator);",
      ]);
    });

    it("validates Record<Model> values instead of treating the record as an array", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Tag { name: string; }
        model Box { labels?: Record<Tag>; }

        interface Boxes {
          @route("/boxes") @post create(@body body: Box): void;
          @route("/boxes") @patch update(@body body: MergePatchUpdate<Box>): void;
        }
        `,
        OPTIONS,
      );
      const post = results["Validators/BoxValidator.g.cs"];
      expectAll(post, "BoxValidator", [
        "RuleFor(x => x.Labels).Custom((values, context) =>",
        "foreach (var failure in tagValidator.Validate(entry.Value).Errors)",
        'context.AddFailure($"Labels[{entry.Key}].{failure.PropertyName}", failure.ErrorMessage);',
      ]);
      expectNone(post, "BoxValidator", ["RuleForEach(x => x.Labels"]);

      const patch = results["Validators/BoxPatchValidator.g.cs"];
      expectAll(patch, "BoxPatchValidator", [
        "AbstractValidator<MergePatch<Tag>> tagPatchValidator",
        "// Labels is merged key by key, so each supplied value is validated as a nested patch",
        "var nestedPatch = MergePatch<Tag>.FromJson(entry.Value.GetRawText(), jsonSerializerOptions);",
      ]);
      expectNone(patch, "BoxPatchValidator", ["'Labels' must be an array."]);
      ok(
        results["Validators/TagPatchValidator.g.cs"],
        "expected TagPatchValidator",
      );
    });

    it("validates a property only in the versions between @added and @removed", async () => {
      const results = await emit(
        versionedSource(
          `
          model Widget {
            name: string;
            @removed(Versions.v2) legacy: string;
            @added(Versions.v2) @removed(Versions.v3) interim: string;
            @added(Versions.v3) modern: string;
          }
          `,
          `interface Widgets {
            @route("/widgets") @post create(@body body: Widget): void;
            @route("/widgets") @patch update(@body body: MergePatchUpdate<Widget>): void;
          }`,
        ),
        OPTIONS,
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      expectAll(post, "WidgetValidator", [
        "// Rules for versions before v2",
        'When(_ => IsVersionInRange("v1", "v2"), () =>',
        "// Rules for v2 up to (not including) v3",
        'When(_ => IsVersionInRange("v2", "v3"), () =>',
        "// Rules for v3 and later",
        'When(_ => IsVersionInRange("v3", null), () =>',
      ]);
      const legacyGroup = post.indexOf('IsVersionInRange("v1", "v2")');
      const interimGroup = post.indexOf('IsVersionInRange("v2", "v3")');
      const legacyRule = post.indexOf("RuleFor(x => x.Legacy).NotEmpty();");
      ok(
        legacyRule > legacyGroup && legacyRule < interimGroup,
        `expected Legacy inside the v1 block:\n${post}`,
      );
      expectAll(
        results["Validators/WidgetPatchValidator.g.cs"],
        "WidgetPatchValidator",
        ['When(_ => IsVersionInRange("v1", "v2"), () =>'],
      );
    });

    it("keeps required rules for a @madeOptional property in the versions before it became optional", async () => {
      const source = versionedSource(
        `
        model Widget {
          @madeOptional(Versions.v2) note?: string;
        }
        `,
        `interface Widgets {
          @route("/widgets") @post create(@body body: Widget): void;
          @route("/widgets") @patch update(@body body: MergePatchUpdate<Widget>): void;
        }`,
      );
      const aware = await emit(source, OPTIONS);
      const post = aware["Validators/WidgetValidator.g.cs"];
      const group = post.indexOf(
        'When(_ => IsVersionInRange("v1", "v2"), () =>',
      );
      ok(
        group >= 0 && post.indexOf("RuleFor(x => x.Note).NotEmpty();") > group,
        `expected Note to be required only before v2:\n${post}`,
      );
      expectAll(
        aware["Validators/WidgetPatchValidator.g.cs"],
        "WidgetPatchValidator",
        [
          'When(_ => IsVersionInRange("v1", "v2"), () =>',
          '.Must(x => !x.IsNull("note"))',
        ],
      );

      const perVersion = await emit(source, {
        ...OPTIONS,
        "validators-version-strategy": "per-version",
      });
      expectAll(
        perVersion["Validators/v1/WidgetValidator.g.cs"],
        "v1/WidgetValidator",
        ["RuleFor(x => x.Note).NotEmpty();"],
      );
      expectNone(
        perVersion["Validators/v2/WidgetValidator.g.cs"],
        "v2/WidgetValidator",
        ["RuleFor(x => x.Note).NotEmpty();"],
      );
    });

    it("reads the API version per validation, normalizes it, and treats an unknown version as the latest", async () => {
      const results = await emit(
        versionedSource(
          `model Widget { @added(Versions.v2) size: int32; }`,
          `interface Widgets { @route("/widgets") @post create(@body body: Widget): void; }`,
        ),
        { ...OPTIONS, validators: "post" },
      );
      const post = results["Validators/WidgetValidator.g.cs"];
      expectAll(post, "WidgetValidator", [
        "private readonly IHttpContextAccessor _httpContextAccessor;",
        "_httpContextAccessor = httpContextAccessor;",
        "var requested = ResolveApiVersion(_httpContextAccessor.HttpContext);",
        "var index = System.Array.IndexOf(_normalizedVersions, NormalizeVersion(requested));",
        "return index >= 0 ? index : _versions.Length - 1;",
        "private static string NormalizeVersion(string version)",
      ]);
      expectNone(post, "WidgetValidator", ["_apiVersion", "IsAtLeast("]);
      expectAll(
        results["Validators/ValidatorsInitializer.g.cs"],
        "ValidatorsInitializer",
        [
          "services.AddSingleton<WidgetValidator>();",
          "services.AddSingleton<IValidator<Widget>>(sp => sp.GetRequiredService<WidgetValidator>());",
        ],
      );
      expectNone(
        results["Validators/ValidatorsInitializer.g.cs"],
        "ValidatorsInitializer",
        ["AddScoped"],
      );
    });

    it("validates inherited properties in a derived validator and keeps the base from repeating them", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Entity { @visibility(Lifecycle.Read) id?: string; }

        @discriminator("kind")
        model Pet extends Entity { kind: string; @maxLength(20) name: string; }
        model Dog extends Pet { kind: "dog"; barks: boolean; }

        interface Pets {
          @route("/pets") @post create(@body body: Pet): void;
          @route("/dogs") @post createDog(@body body: Dog): void;
          @route("/dogs") @patch updateDog(@body body: MergePatchUpdate<Dog>): void;
        }
        `,
        OPTIONS,
      );
      expectAll(results["Validators/DogValidator.g.cs"], "DogValidator", [
        "RuleFor(x => x.Id).Null();",
        "RuleFor(x => x.Name).NotEmpty();",
        "RuleFor(x => x.Name).MaximumLength(20);",
        "RuleFor(x => x.Barks).NotNull();",
      ]);
      expectAll(
        results["Validators/DogPatchValidator.g.cs"],
        "DogPatchValidator",
        [
          '.Must(x => !x.IsDefined("id"))',
          '.Must(x => (x.GetString("name")?.Length ?? 0) <= 20)',
        ],
      );
      expectAll(results["Validators/PetValidator.g.cs"], "PetValidator", [
        "private static readonly System.Collections.Generic.HashSet<System.Type> _derivedTypes = new() { typeof(Dog) };",
        "When(x => !_derivedTypes.Contains(x.GetType()), () =>",
        "            RuleFor(x => x.Name).NotEmpty();",
      ]);
    });

    it("enforces item counts and exclusive bounds", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Album {
          @minItems(1) @maxItems(5) photos: string[];
          @minValueExclusive(0) rating?: float64;
        }

        interface Albums {
          @route("/albums") @post create(@body body: Album): void;
          @route("/albums") @patch update(@body body: MergePatchUpdate<Album>): void;
        }
        `,
        OPTIONS,
      );
      expectAll(results["Validators/AlbumValidator.g.cs"], "AlbumValidator", [
        `RuleFor(x => x.Photos).Must(value => value is null || value.Count >= 1).WithMessage("'{PropertyName}' must contain at least 1 items.");`,
        `RuleFor(x => x.Photos).Must(value => value is null || value.Count <= 5).WithMessage("'{PropertyName}' must not contain more than 5 items.");`,
        "RuleFor(x => x.Rating).GreaterThan(0d);",
      ]);
      expectAll(
        results["Validators/AlbumPatchValidator.g.cs"],
        "AlbumPatchValidator",
        [
          "items.GetArrayLength() >= 1",
          "items.GetArrayLength() <= 5",
          '.Must(x => TryGetDouble(x, "rating", out var n) && n > 0d)',
        ],
      );
    });

    it("validates PUT bodies without the create-only rejection rules", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Doc {
          @visibility(Lifecycle.Read) id?: string;
          title: string;
          @visibility(Lifecycle.Read, Lifecycle.Update) status?: string;
        }

        @route("/docs/{id}") interface Docs { @put replace(@path id: string, @body body: Doc): void; }
        `,
        OPTIONS,
      );
      const validator = results["Validators/DocValidator.g.cs"];
      expectAll(validator, "DocValidator", [
        "RuleFor(x => x.Id).Null();",
        "RuleFor(x => x.Title).NotEmpty();",
      ]);
      expectNone(validator, "DocValidator", ["RuleFor(x => x.Status).Null()"]);
      expectAll(
        results["Validators/ValidatorsInitializer.g.cs"],
        "ValidatorsInitializer",
        [
          "services.AddSingleton<IValidator<Doc>>(sp => sp.GetRequiredService<DocValidator>());",
        ],
      );
    });

    it("gives every MergePatch value rule a message", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        enum Color { red, blue }
        model Widget {
          @minLength(2) @maxLength(9) @pattern("^[a-z]+$") name: string;
          @format("email") owner?: string;
          @minValue(1) @maxValue(9) count?: int32;
          color?: Color;
        }

        @route("/widgets") interface Widgets { @patch update(@body body: MergePatchUpdate<Widget>): void; }
        `,
        OPTIONS,
      );
      const patch = results["Validators/WidgetPatchValidator.g.cs"];
      expectAll(patch, "WidgetPatchValidator", [
        `.WithMessage("'Name' must not be empty.");`,
        `.WithMessage("'Name' must be at least 2 characters.");`,
        `.WithMessage("'Name' must be 9 characters or fewer.");`,
        `.WithMessage("'Name' is not in the correct format.");`,
        `.WithMessage("'Owner' is not a valid email address.");`,
        `.WithMessage("'Count' must be a number greater than or equal to 1.");`,
        `.WithMessage("'Count' must be a number less than or equal to 9.");`,
        `.WithMessage("'Color' is not a valid value.");`,
      ]);
      const ruleCount = patch.split("this.RuleFor(x => x)").length - 1;
      const messageCount = patch.split(".WithMessage(").length - 1;
      strictEqual(messageCount, ruleCount, patch);
    });

    it("compiles each pattern once into a static Regex with a match timeout", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Widget { @pattern("^[a-z]+$") slug?: string; }

        interface Widgets {
          @route("/widgets") @post create(@body body: Widget): void;
          @route("/widgets") @patch update(@body body: MergePatchUpdate<Widget>): void;
        }
        `,
        OPTIONS,
      );
      for (const name of ["WidgetValidator", "WidgetPatchValidator"]) {
        const file = results[`Validators/${name}.g.cs`];
        expectAll(file, name, [
          'private static readonly System.Text.RegularExpressions.Regex _slugPattern = new(@"^[a-z]+$", System.Text.RegularExpressions.RegexOptions.None, System.TimeSpan.FromSeconds(1));',
          "catch (System.Text.RegularExpressions.RegexMatchTimeoutException)",
        ]);
        expectNone(file, name, ["Regex.IsMatch(", ".Matches(@"]);
      }
    });

    it("patches the runtime type and merges nested objects into the existing instance", async () => {
      for (const style of ["generic", "typed"]) {
        const results = await emit(
          `
          import "@typespec/http";
          using TypeSpec.Http;
          @service namespace Demo;

          model Widget { name?: string; }
          @route("/widgets") interface Widgets { @patch update(@body body: MergePatchUpdate<Widget>): void; }
          `,
          { ...OPTIONS, "merge-patch-style": style },
        );
        const helper =
          style === "generic"
            ? results["Helpers/MergePatch.g.cs"]
            : results["WidgetMergePatchUpdate.g.cs"];
        expectAll(helper, `${style} helper`, [
          "PatchObject(original, original.GetType(), Properties, rejected, string.Empty, options);",
          "&& property.GetValue(target) is { } nested)",
          "PatchObject(nested, nested.GetType(), nestedValues, rejected, JoinPath(prefix, member.Value.WireName), options);",
          "JsonSerializer.SerializeToNode(target, type, options)",
          "if (property.GetIndexParameters().Length > 0) continue;",
        ]);
        expectNone(helper, `${style} helper`, [
          "SerializeToNode(original, options)",
        ]);
      }
    });

    it("rejects a read-only property before merging into its nested object", async () => {
      for (const style of ["generic", "typed"]) {
        const results = await emit(
          `
          import "@typespec/http";
          using TypeSpec.Http;
          @service namespace Demo;

          model Widget { name?: string; }
          @route("/widgets") interface Widgets { @patch update(@body body: MergePatchUpdate<Widget>): void; }
          `,
          { ...OPTIONS, "merge-patch-style": style },
        );
        const helper =
          style === "generic"
            ? results["Helpers/MergePatch.g.cs"]
            : results["WidgetMergePatchUpdate.g.cs"];
        ok(helper, `expected the ${style} helper`);
        const canWrite = helper.indexOf("if (!property.CanWrite)");
        const merge = helper.indexOf("IsModelType(property.PropertyType)");
        ok(
          canWrite >= 0 && merge > canWrite,
          `expected the CanWrite rejection before the nested merge in the ${style} helper:\n${helper}`,
        );
      }
    });

    it("never patches a [JsonIgnore] property or merges into its nested object", async () => {
      for (const style of ["generic", "typed"]) {
        const results = await emit(
          `
          import "@typespec/http";
          using TypeSpec.Http;
          @service namespace Demo;

          model Widget { name?: string; }
          @route("/widgets") interface Widgets { @patch update(@body body: MergePatchUpdate<Widget>): void; }
          `,
          { ...OPTIONS, "merge-patch-style": style },
        );
        const helper =
          style === "generic"
            ? results["Helpers/MergePatch.g.cs"]
            : results["WidgetMergePatchUpdate.g.cs"];
        expectAll(helper, `${style} helper`, [
          "if (property.GetCustomAttribute<JsonIgnoreAttribute>() is { Condition: JsonIgnoreCondition.Always }) continue;",
        ]);
      }
    });

    it("compares floating-point MergePatch bounds as double and keeps out-of-range bounds compilable", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Measure {
          @minValueExclusive(1e30) huge?: float64;
          @maxValueExclusive(-1e30) tiny?: float64;
          @minValue(0.5) ratio?: float32;
          @maxValue(9223372036854775807) wide?: int64;
          @maxValue(1e30) money?: decimal;
          @minValue(1e30) richer?: decimal;
          @minValue(2) qty?: int32;
        }

        interface Measures {
          @route("/m") @post create(@body body: Measure): void;
          @route("/m") @patch update(@body body: MergePatchUpdate<Measure>): void;
        }
        `,
        OPTIONS,
      );
      const post = results["Validators/MeasureValidator.g.cs"];
      expectAll(post, "MeasureValidator", [
        "RuleFor(x => x.Huge).GreaterThan(1e+30d);",
        "RuleFor(x => x.Tiny).LessThan(-1e+30d);",
        "RuleFor(x => x.Ratio).GreaterThanOrEqualTo(0.5f);",
        "RuleFor(x => x.Richer).GreaterThanOrEqualTo(79228162514264337593543950335m);",
        "RuleFor(x => x.Qty).GreaterThanOrEqualTo(2);",
      ]);
      expectNone(post, "MeasureValidator", [
        "RuleFor(x => x.Wide)",
        "RuleFor(x => x.Money)",
        "9223372036854775808",
      ]);

      const patch = results["Validators/MeasurePatchValidator.g.cs"];
      expectAll(patch, "MeasurePatchValidator", [
        '.Must(x => TryGetDouble(x, "huge", out var n) && n > 1e+30d)',
        '.Must(x => TryGetDouble(x, "tiny", out var n) && n < -1e+30d)',
        '.Must(x => TryGetDouble(x, "ratio", out var n) && n >= 0.5d)',
        '.Must(x => TryGetNumber(x, "richer", out var n) && n >= 79228162514264337593543950335m)',
        '.Must(x => TryGetNumber(x, "qty", out var n) && n >= 2m)',
        "private static bool TryGetDouble(MergePatch<Measure> patch, string name, out double value)",
        "private static bool TryGetNumber(MergePatch<Measure> patch, string name, out decimal value)",
      ]);
      expectNone(patch, "MeasurePatchValidator", [
        "1e+30m",
        '"wide"',
        '"money"',
      ]);
    });

    it("uses the base class's identifiers for inherited properties in a derived validator", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Item { item: string; user_id: string; userId: string; }
        model SpecialItem extends Item { extra?: string; }

        @route("/special") interface Special { @post create(@body body: SpecialItem): void; }
        `,
        { ...OPTIONS, validators: "post" },
      );
      const model = results["Models/Item.g.cs"];
      expectAll(model, "Item", [
        "public string? ItemValue { get; set; }",
        "public string? UserId { get; set; }",
        "public string? UserId2 { get; set; }",
      ]);
      const validator = results["Validators/SpecialItemValidator.g.cs"];
      expectAll(validator, "SpecialItemValidator", [
        "RuleFor(x => x.ItemValue).NotEmpty();",
        "RuleFor(x => x.UserId).NotEmpty();",
        "RuleFor(x => x.UserId2).NotEmpty();",
      ]);
      expectNone(validator, "SpecialItemValidator", ["RuleFor(x => x.Item)."]);
    });

    it("drops the @ of an escaped keyword from the pattern field name", async () => {
      const results = await emit(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using TypeSpec.Http;
        @service namespace Demo;

        model Keyed { @serverName("@class") @pattern("^[a-z]+$") klass?: string; }

        interface Keys {
          @route("/keys") @post create(@body body: Keyed): void;
          @route("/keys") @patch update(@body body: MergePatchUpdate<Keyed>): void;
        }
        `,
        OPTIONS,
      );
      expectAll(results["Validators/KeyedValidator.g.cs"], "KeyedValidator", [
        "System.Text.RegularExpressions.Regex _classPattern = new(",
        "RuleFor(x => x.@class).Must(value => IsMatch(_classPattern, value))",
      ]);
      expectAll(
        results["Validators/KeyedPatchValidator.g.cs"],
        "KeyedPatchValidator",
        [
          "System.Text.RegularExpressions.Regex _classPattern = new(",
          '.Must(x => IsMatch(_classPattern, x.GetString("klass")))',
        ],
      );
      for (const name of ["KeyedValidator", "KeyedPatchValidator"]) {
        expectNone(results[`Validators/${name}.g.cs`], name, ["_@"]);
      }
    });

    it("enforces a zero @maxItems or @maxLength", async () => {
      const results = await emit(
        `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace Demo;

        model Box { @maxItems(0) none?: string[]; @maxLength(0) blank?: string; }

        interface Boxes {
          @route("/boxes") @post create(@body body: Box): void;
          @route("/boxes") @patch update(@body body: MergePatchUpdate<Box>): void;
        }
        `,
        OPTIONS,
      );
      expectAll(results["Validators/BoxValidator.g.cs"], "BoxValidator", [
        "RuleFor(x => x.None).Must(value => value is null || value.Count <= 0)",
        "RuleFor(x => x.Blank).MaximumLength(0);",
      ]);
      expectAll(
        results["Validators/BoxPatchValidator.g.cs"],
        "BoxPatchValidator",
        [
          "items.GetArrayLength() <= 0",
          '.Must(x => (x.GetString("blank")?.Length ?? 0) <= 0)',
        ],
      );
    });
  });
});
