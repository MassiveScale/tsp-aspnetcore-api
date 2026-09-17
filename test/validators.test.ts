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

describe("csharp emitter - validators", () => {
  describe("@discriminator decorator", () => {
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
        petValidator.includes("v.Add<Demo.Models.Cat>(catValidator)"),
        `expected Cat dispatch in base validator:\n${petValidator}`,
      );
      ok(
        petValidator.includes("v.Add<Demo.Models.Dog>(dogValidator)"),
        `expected Dog dispatch in base validator:\n${petValidator}`,
      );
      // Constructor should accept derived-type validators
      ok(
        petValidator.includes(
          "AbstractValidator<Demo.Models.Cat> catValidator",
        ),
        `expected Cat validator parameter:\n${petValidator}`,
      );
      ok(
        petValidator.includes(
          "AbstractValidator<Demo.Models.Dog> dogValidator",
        ),
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
        petValidator.includes(
          "AbstractValidator<Demo.Models.Labrador> labradorValidator",
        ),
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

      // A MergePatch body carries no strongly-typed Author/Tags members — only the
      // raw JsonElement bag — so nested-model rules are suppressed there entirely.
      const patchValidator = results["Validators/BookPatchValidator.g.cs"];
      ok(
        patchValidator,
        `expected Validators/BookPatchValidator.g.cs, got: ${Object.keys(results).join(", ")}`,
      );
      ok(
        patchValidator.includes(
          "AbstractValidator<Demo.Helpers.MergePatch<Demo.Models.Book>>",
        ),
        `expected the patch validator to target the MergePatch body in:\n${patchValidator}`,
      );
      ok(
        !patchValidator.includes("SetValidator") &&
          !patchValidator.includes("authorValidator") &&
          !patchValidator.includes("tagValidator"),
        `expected nested-model rules to be suppressed for a MergePatch body in:\n${patchValidator}`,
      );
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
        postValidator.includes("Rules added in v2.0"),
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
        patchValidator.includes("Rules added in v2.0"),
        `expected the version-aware PATCH template to be used:\n${patchValidator}`,
      );
      ok(
        !patchValidator.includes("SetValidator") &&
          !patchValidator.includes("authorValidator") &&
          !patchValidator.includes("tagValidator"),
        `expected nested-model rules to be suppressed for a MergePatch body in both the base and per-version blocks of:\n${patchValidator}`,
      );
    });
  });
});
