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
        'RuleFor(x => x.Slug).Matches(@"^[a-z]+$").When(x => x.Slug is not null);',
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
        validator.includes(
          "AbstractValidator<Demo.Models.Targeting> targetingValidator",
        ) &&
          validator.includes(
            "AbstractValidator<Demo.Models.Segment> segmentValidator",
          ),
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
        validator.includes("Rules added in v2.0"),
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
        validator.includes(
          "AbstractValidator<Demo.Helpers.MergePatch<Demo.Models.Widget>>",
        ),
        `expected the validator to target the MergePatch body in:\n${validator}`,
      );
      ok(
        validator.includes(
          '.When(x => x.IsDefined("Target") && !x.IsNull("Target"))',
        ) && validator.includes('x.GetString("Name")'),
        `expected MergePatch bodies to keep the string-keyed rule shape in:\n${validator}`,
      );
      ok(
        !validator.includes("RuleFor(x => x.Target)"),
        `did not expect typed property access against a MergePatch body in:\n${validator}`,
      );
    });
  });
});
