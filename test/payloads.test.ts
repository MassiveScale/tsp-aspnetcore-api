import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

/** Returns the sorted class/interface file names emitted under `Models/`. */
function modelFiles(results: Record<string, string>): string[] {
  return Object.keys(results)
    .filter((key) => key.startsWith("Models/"))
    .map((key) => key.slice("Models/".length))
    .sort();
}

/** Asserts that `file` exists and contains `expected`. */
function assertContains(
  file: string | undefined,
  expected: string,
  label: string,
): void {
  ok(file, `expected ${label} to be emitted`);
  ok(
    file.includes(expected),
    `expected ${label} to contain:\n  ${expected}\n\nin:\n${file}`,
  );
}

const HTTP_HEADER = `
  import "@typespec/http";
  using Http;
`;

const REPRO = `
  ${HTTP_HEADER}
  @service namespace Repro;

  model Widget { name: string; }
  model Gadget { size: int32; }

  model ETagHeader { @header("ETag") etag: string; }
  model IfMatchHeader { @header("If-Match") ifMatch?: string; }
  model EntityResponse<T> { ...OkResponse; ...ETagHeader; @body body: T; }
  model UpdatedResponse { ...NoContentResponse; ...ETagHeader; }
  @error model Problem { title: string; status: int32; }
  @error model NotFoundError { ...NotFoundResponse; @body body: Problem; }

  @route("/widgets") interface Widgets {
    @get read(): EntityResponse<Widget> | NotFoundError;
    @patch update(...IfMatchHeader, @body body: Widget): UpdatedResponse | NotFoundError;
  }
  @route("/gadgets") interface Gadgets {
    @get read(): EntityResponse<Gadget> | NotFoundError;
  }
`;

describe("csharp emitter - response and metadata-only models", () => {
  describe("repro", () => {
    it("emits classes only for the payload types Widget, Gadget and Problem", async () => {
      const results = await emit(REPRO);
      deepStrictEqual(modelFiles(results), [
        "Gadget.g.cs",
        "Problem.g.cs",
        "Widget.g.cs",
      ]);
    });

    it("keeps service signatures that reference the body types", async () => {
      const results = await emit(REPRO);
      const widgets = results["Services/IWidgetsService.g.cs"];
      assertContains(
        widgets,
        "Task<Repro.Models.Widget?> ReadAsync(CancellationToken cancellationToken);",
        "IWidgetsService",
      );
      assertContains(
        widgets,
        "Task UpdateAsync(string? ifMatch, Repro.Models.Widget body, CancellationToken cancellationToken);",
        "IWidgetsService",
      );
      assertContains(
        results["Services/IGadgetsService.g.cs"],
        "Task<Repro.Models.Gadget?> ReadAsync(CancellationToken cancellationToken);",
        "IGadgetsService",
      );
    });

    it("keeps the spread If-Match header as a controller parameter", async () => {
      const results = await emit(REPRO);
      assertContains(
        results["Controllers/WidgetsControllerBase.g.cs"],
        'public abstract Task<IActionResult> Update([FromHeader(Name = "If-Match")] string? ifMatch, [FromBody] Repro.Models.Widget body, CancellationToken cancellationToken);',
        "WidgetsControllerBase",
      );
    });

    it("emits no class whose properties are HTTP metadata", async () => {
      const results = await emit(REPRO);
      for (const [path, content] of Object.entries(results)) {
        if (!path.startsWith("Models/")) continue;
        ok(
          !content.includes("StatusCode") &&
            !content.includes("Etag") &&
            !content.includes(" Body {"),
          `expected no metadata or envelope properties in ${path}:\n${content}`,
        );
      }
    });
  });

  describe("payload reachability (requirement 1)", () => {
    it("emits property types, base models and array elements of a payload", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Audit { by: string; }
        model Entity { audit: Audit; }
        model Tag { label: string; }
        model Widget extends Entity { tags: Tag[]; meta: Record<Tag>; }

        @route("/w") interface Widgets { @get list(): Widget[]; }
      `);
      deepStrictEqual(modelFiles(results), [
        "Audit.g.cs",
        "Entity.g.cs",
        "Tag.g.cs",
        "Widget.g.cs",
      ]);
    });

    it("drops models that no operation payload reaches when operations exist", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model Unused { value: string; }

        @route("/w") interface Widgets { @get read(): Widget; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
    });

    it("emits every data model when the program has no HTTP operations", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        namespace Demo;

        model Widget { name: string; }
        model Unused { value: string; }
        model ETagHeader { @header("ETag") etag: string; }
        model Envelope { @statusCode code: 200; @body body: Widget; }
        model Empty {}
      `);
      deepStrictEqual(modelFiles(results), [
        "Empty.g.cs",
        "Unused.g.cs",
        "Widget.g.cs",
      ]);
    });

    it("emits request body types and model-typed parameters", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model Filter { term: string; }

        @route("/w") interface Widgets {
          @post create(@body body: Widget): void;
          @get search(@query filter: Filter): void;
        }
      `);
      deepStrictEqual(modelFiles(results), ["Filter.g.cs", "Widget.g.cs"]);
    });

    it("emits every derived model of a discriminated payload", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        @discriminator("kind")
        model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }
        model Cat extends Pet { kind: "cat"; }

        @route("/pets") interface Pets { @get read(): Pet; }
      `);
      deepStrictEqual(modelFiles(results), [
        "Cat.g.cs",
        "Dog.g.cs",
        "Pet.g.cs",
      ]);
    });

    it("emits the source model of a MergePatchUpdate request body", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }

        @route("/w") interface Widgets {
          @patch update(@body body: MergePatchUpdate<Widget>): void;
        }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
    });

    it("emits union variants and anonymous-model property types of a payload", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Cat { meow: string; }
        model Dog { bark: string; }
        model Owner { name: string; }

        @route("/p") interface Pets {
          @get read(): { owner: Owner; pet: Cat | Dog };
        }
      `);
      deepStrictEqual(modelFiles(results), [
        "Cat.g.cs",
        "Dog.g.cs",
        "Owner.g.cs",
      ]);
    });

    it("emits models referenced through tuples and union-variant references", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Cat { meow: string; }
        model Dog { bark: string; }
        model Left { l: string; }
        model Right { r: string; }
        union Pets { cat: Cat, dog: Dog }
        model Holder { favourite: Pets.cat; pair: [Left, Right]; }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      deepStrictEqual(modelFiles(results), [
        "Cat.g.cs",
        "Holder.g.cs",
        "Left.g.cs",
        "Right.g.cs",
      ]);
    });

    it("emits a model reused as both a payload and a property type once", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Address { city: string; }
        model Customer { name: string; address: Address; }

        @route("/a") interface Addresses { @get read(): Address; }
        @route("/c") interface Customers { @get read(): Customer; }
      `);
      deepStrictEqual(modelFiles(results), ["Address.g.cs", "Customer.g.cs"]);
      assertContains(
        results["Models/Customer.g.cs"],
        "public Demo.Models.Address? Address { get; set; }",
        "Customer",
      );
      assertContains(
        results["Services/IAddressesService.g.cs"],
        "Task<Demo.Models.Address?> ReadAsync(",
        "IAddressesService",
      );
    });
  });

  describe("metadata-only models (requirement 2)", () => {
    it("never emits metadata-only models, including OkResponse spreads", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model Ok { ...OkResponse; }
        model Paging { @query skip?: int32; @query top?: int32; }
        model WidgetId { @path id: string; }
        model RequestId { @header("x-request-id") requestId: string; }

        @route("/w") interface Widgets {
          @get list(...Paging): Ok;
          @get @route("{id}") read(...WidgetId, ...RequestId): Widget;
        }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
    });

    it("drops a property typed as a metadata-only model instead of referencing a missing class", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model ETagHeader { @header("ETag") etag: string; }
        model Widget { name: string; headers: ETagHeader; }

        @route("/w") interface Widgets { @get read(): Widget; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
      const widget = results["Models/Widget.g.cs"];
      assertContains(widget, " Name { get; set; }", "Widget");
      ok(
        !widget.includes("ETagHeader") && !widget.includes(" Headers {"),
        `expected no reference to the unemitted ETagHeader in:\n${widget}`,
      );
    });

    it("drops properties that reach an envelope model through arrays, records and unions", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model ETagHeader { @header("ETag") etag: string; }
        union Choice { tag: ETagHeader, text: string }
        model Widget {
          name: string;
          list: ETagHeader[];
          map: Record<ETagHeader>;
          either: ETagHeader | null;
          variant: Choice.tag;
          pair: [ETagHeader, string];
        }

        @route("/w") interface Widgets { @get read(): Widget; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
      const widget = results["Models/Widget.g.cs"];
      for (const dropped of ["List", "Map", "Either", "Variant", "Pair"]) {
        ok(
          !widget.includes(` ${dropped} {`),
          `expected ${dropped} to be dropped from:\n${widget}`,
        );
      }
    });
  });

  describe("inheritance from envelope models", () => {
    it("drops the base class when the base is metadata-only and flattens its @path data", async () => {
      const results = await emit(
        `
        ${HTTP_HEADER}
        @service namespace Demo;

        model TraceBase { @header("x-trace") trace: string; }
        model KeyBase extends TraceBase { @path id: string; }
        model Widget extends KeyBase { name: string; }

        @route("/w") interface Widgets { @get read(): Widget; }
        `,
        { "emit-interfaces": true },
      );
      deepStrictEqual(modelFiles(results), ["IWidget.g.cs", "Widget.g.cs"]);
      const widget = results["Models/Widget.g.cs"];
      assertContains(
        widget,
        "public partial class Widget : Demo.Models.IWidget",
        "Widget",
      );
      assertContains(widget, " Id { get; set; }", "Widget");
      assertContains(widget, " Name { get; set; }", "Widget");
      ok(
        !widget.includes("TraceBase") &&
          !widget.includes("KeyBase") &&
          !widget.includes(" Trace {"),
        `expected no envelope base or header property in:\n${widget}`,
      );
      const iface = results["Models/IWidget.g.cs"];
      assertContains(iface, "public partial interface IWidget", "IWidget");
      ok(
        !/interface IWidget\s*:/.test(iface),
        `expected IWidget to have no base interface:\n${iface}`,
      );
    });

    it("strips header properties from a base that mixes metadata and data", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model MixedBase { @header("x-trace") trace: string; id: string; }
        model Widget extends MixedBase { name: string; }

        @route("/w") interface Widgets { @get read(): Widget; }
      `);
      deepStrictEqual(modelFiles(results), ["MixedBase.g.cs", "Widget.g.cs"]);
      assertContains(
        results["Models/Widget.g.cs"],
        "public partial class Widget : Demo.Models.MixedBase",
        "Widget",
      );
      const base = results["Models/MixedBase.g.cs"];
      assertContains(base, " Id { get; set; }", "MixedBase");
      ok(
        !base.includes(" Trace {"),
        `expected the header property to be stripped from:\n${base}`,
      );
    });
  });

  describe("explicit-body response models (requirement 3)", () => {
    it("emits the @body type instead of the response model", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model WidgetResponse { @statusCode code: 200; @header("ETag") etag: string; @body body: Widget; }

        @route("/w") interface Widgets { @get read(): WidgetResponse; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.Widget?> ReadAsync(",
        "IWidgetsService",
      );
    });

    it("emits the @bodyRoot type instead of the response model", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model WidgetResponse { @statusCode code: 201; @bodyRoot widget: Widget; }

        @route("/w") interface Widgets { @post create(): WidgetResponse; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.Widget?> CreateAsync(",
        "IWidgetsService",
      );
    });

    it("does not emit a response model inherited from one with an explicit body", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model BaseResponse { @body body: Widget; }
        model WidgetResponse extends BaseResponse { @header("ETag") etag: string; }

        @route("/w") interface Widgets { @get read(): WidgetResponse; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
    });
  });

  describe("implicit-body response models (requirement 4)", () => {
    const IMPLICIT = `
      ${HTTP_HEADER}
      @service namespace Demo;

      model Owner { name: string; }
      model WidgetResult {
        @header("ETag") etag: string;
        @header("x-mode") mode: "fast" | "slow";
        name: string;
        owner: Owner;
      }

      @route("/w") interface Widgets { @get read(): WidgetResult; }
    `;

    it("emits the response model without its metadata properties", async () => {
      const results = await emit(IMPLICIT, { "emit-interfaces": true });
      deepStrictEqual(modelFiles(results), [
        "IOwner.g.cs",
        "IWidgetResult.g.cs",
        "Owner.g.cs",
        "WidgetResult.g.cs",
      ]);
      for (const file of ["WidgetResult.g.cs", "IWidgetResult.g.cs"]) {
        const content = results[`Models/${file}`];
        assertContains(content, " Name { get; set; }", file);
        assertContains(content, " Owner { get; set; }", file);
        ok(
          !content.includes(" Etag {") && !content.includes(" Mode {"),
          `expected metadata properties to be omitted from ${file}:\n${content}`,
        );
      }
    });

    it("returns the emitted response model from the service", async () => {
      const results = await emit(IMPLICIT);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.WidgetResult?> ReadAsync(CancellationToken cancellationToken);",
        "IWidgetsService",
      );
    });

    it("strips header properties even when the model is also nested in another payload", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model WidgetResult { @header("ETag") etag: string; name: string; }
        model Batch { items: WidgetResult[]; }

        @route("/w") interface Widgets {
          @get read(): WidgetResult;
          @get @route("batch") batch(): Batch;
        }
      `);
      const result = results["Models/WidgetResult.g.cs"];
      assertContains(result, " Name { get; set; }", "WidgetResult");
      ok(
        !result.includes(" Etag {"),
        `expected the header to be stripped from:\n${result}`,
      );
    });

    it("strips header properties from a self-referencing implicit body", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Node { @header h: string; value: string; next?: Node; }

        @route("/n") interface Nodes { @get read(): Node; }
      `);
      const node = results["Models/Node.g.cs"];
      assertContains(node, " Value { get; set; }", "Node");
      assertContains(
        node,
        "public Demo.Models.Node? Next { get; set; }",
        "Node",
      );
      ok(!node.includes(" H {"), `expected no H property in:\n${node}`);
    });

    it("keeps @path and @query properties on a returned resource", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { @path id: string; @query expand?: string; @header("x-v") ver: string; name: string; }

        @route("/w") interface Widgets { @get @route("{id}") read(@path id: string): Widget; }
      `);
      const widget = results["Models/Widget.g.cs"];
      assertContains(widget, " Id { get; set; }", "Widget");
      assertContains(widget, " Expand { get; set; }", "Widget");
      ok(!widget.includes(" Ver {"), `expected no Ver property in:\n${widget}`);
    });

    it("leaves an anonymous implicit request body as object", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        @route("/w") interface Widgets {
          @post create(@header("x-trace") trace: string, name: string): void;
        }
      `);
      deepStrictEqual(modelFiles(results), []);
      assertContains(
        results["Controllers/WidgetsControllerBase.g.cs"],
        '[FromHeader(Name = "x-trace")] string trace, [FromBody] object body',
        "WidgetsControllerBase",
      );
    });
  });

  describe("template instances (requirement 5)", () => {
    const PAGED = `
      ${HTTP_HEADER}
      @service namespace Demo;

      model Widget { name: string; }
      model Gadget { size: int32; }
      model PagedResult<T> { items: T[]; next?: string; }
      model WidgetList is PagedResult<Widget>;

      @route("/w") interface Widgets {
        @get list(): PagedResult<Widget>;
        @get @route("all") all(): WidgetList;
      }
      @route("/g") interface Gadgets {
        @get list(): PagedResult<Gadget>;
        @get @route("nested") nested(): PagedResult<Gadget[]>;
      }
    `;

    it("emits a distinct class per instantiation instead of collapsing them", async () => {
      const results = await emit(PAGED);
      deepStrictEqual(modelFiles(results), [
        "Gadget.g.cs",
        "PagedResultGadget.g.cs",
        "PagedResultGadgetList.g.cs",
        "PagedResultWidget.g.cs",
        "Widget.g.cs",
        "WidgetList.g.cs",
      ]);
      assertContains(
        results["Models/PagedResultWidget.g.cs"],
        "public IList<Demo.Models.Widget>? Items { get; set; }",
        "PagedResultWidget",
      );
      assertContains(
        results["Models/PagedResultGadget.g.cs"],
        "public IList<Demo.Models.Gadget>? Items { get; set; }",
        "PagedResultGadget",
      );
      assertContains(
        results["Models/PagedResultGadgetList.g.cs"],
        "public IList<IList<Demo.Models.Gadget>>? Items { get; set; }",
        "PagedResultGadgetList",
      );
    });

    it("references each instantiation's class from the service", async () => {
      const results = await emit(PAGED);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.PagedResultWidget?> ListAsync(",
        "IWidgetsService",
      );
      assertContains(
        results["Services/IGadgetsService.g.cs"],
        "Task<Demo.Models.PagedResultGadget?> ListAsync(",
        "IGadgetsService",
      );
    });

    it("keeps `model X is Template<T>` emitted under its own name", async () => {
      const results = await emit(PAGED);
      assertContains(
        results["Models/WidgetList.g.cs"],
        "public partial class WidgetList",
        "WidgetList",
      );
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.WidgetList?> AllAsync(",
        "IWidgetsService",
      );
    });

    it("names an instantiation with @friendlyName when present", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        @friendlyName("{name}Page", T)
        model Page<T> { items: T[]; }

        @route("/w") interface Widgets { @get list(): Page<Widget>; }
      `);
      deepStrictEqual(modelFiles(results), ["Widget.g.cs", "WidgetPage.g.cs"]);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.WidgetPage?> ListAsync(",
        "IWidgetsService",
      );
    });

    it("names instantiations over scalars and references them from properties", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Box<T> { value: T; }
        model Holder { name: Box<string>; count: Box<int32>; }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      deepStrictEqual(modelFiles(results), [
        "BoxInt32.g.cs",
        "BoxString.g.cs",
        "Holder.g.cs",
      ]);
      assertContains(
        results["Models/Holder.g.cs"],
        "public Demo.Models.BoxString? Name { get; set; }",
        "Holder",
      );
    });
  });

  describe("template instance naming", () => {
    it("derives a class-name fragment from every template argument kind", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model Cat { meow: string; }
        model Dog { bark: string; }
        enum Color { red, blue }
        union Shade { light: "light", dark: "dark" }
        model Box<T> { value: T; }
        model Sized<T, N extends valueof int32> { value: T; }

        model Holder {
          map: Box<Record<Widget>>;
          anon: Box<{ id: string }>;
          empty: Box<{}>;
          literal: Box<"on-off">;
          number: Box<42>;
          flag: Box<true>;
          color: Box<Color>;
          shade: Box<Shade>;
          pet: Box<Cat | Dog>;
          sized: Sized<Widget, 3>;
          opaque: Box<unknown>;
        }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      const names = modelFiles(results);
      for (const expected of [
        "BoxWidgetMap.g.cs",
        "BoxId.g.cs",
        "BoxObject.g.cs",
        "BoxOnOff.g.cs",
        "Box42.g.cs",
        "BoxTrue.g.cs",
        "BoxColor.g.cs",
        "BoxShade.g.cs",
        "BoxCatOrDog.g.cs",
        "SizedWidget3.g.cs",
        "BoxShadeValue.g.cs",
        "Box.g.cs",
      ]) {
        ok(
          names.includes(expected),
          `expected ${expected}, got: ${names.join(", ")}`,
        );
      }
      assertContains(
        results["Models/Holder.g.cs"],
        "public Demo.Models.BoxCatOrDog? Pet { get; set; }",
        "Holder",
      );
    });

    it("gives each instantiation its own inferred enum for a literal-union property", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Box<T> { value: T; }
        model Holder { size: Box<"small" | "large">; speed: Box<"slow" | "fast">; }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      const sizeBox = Object.keys(results).find((key) =>
        results[key].includes('[EnumMember(Value = "small")]'),
      );
      const speedBox = Object.keys(results).find((key) =>
        results[key].includes('[EnumMember(Value = "slow")]'),
      );
      ok(sizeBox && speedBox, "expected both inferred enums to be emitted");
      ok(
        sizeBox !== speedBox,
        `expected distinct inferred enums, both landed in ${sizeBox}`,
      );
    });

    it("suffixes an @serverName template name with its arguments", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@massivescale/tsp-aspnetcore-api";
        using Http;
        using MassiveScale.AspNetCoreApi;
        @service namespace Demo;

        model Widget { name: string; }
        @serverName("Page")
        model PagedResult<T> { items: T[]; }

        @route("/w") interface Widgets { @get list(): PagedResult<Widget>; }
      `);
      deepStrictEqual(modelFiles(results), ["PageWidget.g.cs", "Widget.g.cs"]);
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Models.PageWidget?> ListAsync(",
        "IWidgetsService",
      );
    });
  });

  describe("class-name collisions", () => {
    it("gives anonymous template arguments with different shapes distinct classes", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Box<T> { value: T; }
        model Holder { a: Box<{ id: string }>; b: Box<{ name: string }>; }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      deepStrictEqual(modelFiles(results), [
        "BoxId.g.cs",
        "BoxName.g.cs",
        "Holder.g.cs",
      ]);
      const holder = results["Models/Holder.g.cs"];
      assertContains(
        holder,
        "public Demo.Models.BoxId? A { get; set; }",
        "Holder",
      );
      assertContains(
        holder,
        "public Demo.Models.BoxName? B { get; set; }",
        "Holder",
      );
    });

    it("reports duplicate-model-name instead of overwriting a class", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Box<T> { value: T; }
        model Holder { a: Box<{ id: string }>; b: Box<{ id: int32 }>; }

        @route("/h") interface Holders { @get read(): Holder; }
      `);
      const duplicates = diagnostics.filter(
        (d) =>
          d.code === "@massivescale/tsp-aspnetcore-api/duplicate-model-name",
      );
      deepStrictEqual(
        duplicates.length,
        1,
        `got: ${diagnostics.map((d) => d.code).join(", ")}`,
      );
      ok(
        String(duplicates[0].message).includes('"BoxId"'),
        `expected the clashing class name in: ${duplicates[0].message}`,
      );
      deepStrictEqual(
        Object.keys(results).filter((key) => key.startsWith("Models/BoxId")),
        ["Models/BoxId.g.cs"],
      );
    });

    it("reports duplicate-model-name in a program without operations", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        namespace Demo.A { model Widget { name: string; } }
        namespace Demo.B { model Widget { size: int32; } }
      `);
      ok(
        diagnostics.some(
          (d) =>
            d.code === "@massivescale/tsp-aspnetcore-api/duplicate-model-name",
        ),
        `got: ${diagnostics.map((d) => d.code).join(", ")}`,
      );
    });
  });

  describe("@error response envelopes", () => {
    it("does not return the body of an @error envelope that declares a 2xx status", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Problem { title: string; }
        @error model OddError { @statusCode code: 200; @body body: Problem; }
        model Widget { name: string; }

        @route("/w") interface Widgets {
          @get read(): OddError;
          @get @route("both") both(): OddError | Widget;
        }
      `);
      const service = results["Services/IWidgetsService.g.cs"];
      assertContains(
        service,
        "Task ReadAsync(CancellationToken cancellationToken);",
        "IWidgetsService",
      );
      assertContains(
        service,
        "Task<Demo.Models.Widget?> BothAsync(CancellationToken cancellationToken);",
        "IWidgetsService",
      );
    });
  });

  describe("@error bodies and validators (requirement 6)", () => {
    it("emits no validator rule for a header property of a request body", async () => {
      const results = await emit(
        `
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { @header("x-trace") @minLength(3) trace: string; @minLength(1) name: string; }

        @route("/w") interface Widgets { @post create(@bodyRoot body: Widget): void; }
        `,
        { "emit-validators": true },
      );
      const validator = results["Validators/WidgetValidator.g.cs"];
      assertContains(validator, "RuleFor(x => x.Name)", "WidgetValidator");
      ok(
        !validator.includes("x.Trace"),
        `expected no rule for the header property in:\n${validator}`,
      );
    });

    it("emits @error body models and validators for request payloads only", async () => {
      const results = await emit(
        `
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { @minLength(1) name: string; }
        @error model Problem { title: string; }
        @error model NotFoundError { ...NotFoundResponse; @body body: Problem; }
        model Created { ...CreatedResponse; @header("Location") location: string; }

        @route("/w") interface Widgets {
          @post create(@body body: Widget): Created | NotFoundError;
        }
        `,
        { "emit-validators": true },
      );
      deepStrictEqual(modelFiles(results), ["Problem.g.cs", "Widget.g.cs"]);
      const validators = Object.keys(results)
        .filter((key) => key.startsWith("Validators/"))
        .sort();
      deepStrictEqual(validators, [
        "Validators/ValidatorsInitializer.g.cs",
        "Validators/WidgetValidator.g.cs",
      ]);
    });

    it("emits no validators for envelope models in a program without operations", async () => {
      const results = await emit(
        `
        ${HTTP_HEADER}
        namespace Demo;

        model Widget { @minLength(1) name: string; }
        model ETagHeader { @header("ETag") etag: string; }
        model Envelope { @statusCode code: 200; @body body: Widget; }
        `,
        { "emit-validators": true },
      );
      const validators = Object.keys(results).filter((key) =>
        key.startsWith("Validators/"),
      );
      ok(
        validators.every(
          (key) => !key.includes("ETagHeader") && !key.includes("Envelope"),
        ),
        `expected no envelope validators, got: ${validators.join(", ")}`,
      );
      ok(
        validators.includes("Validators/WidgetValidator.g.cs"),
        `expected a Widget validator, got: ${validators.join(", ")}`,
      );
    });
  });

  describe("request handling (requirement 7)", () => {
    it("keeps spread @path, @query and @header parameters on controllers and services", async () => {
      const results = await emit(`
        ${HTTP_HEADER}
        @service namespace Demo;

        model Widget { name: string; }
        model WidgetKey { @path id: string; }
        model Paging { @query top?: int32; }
        model IfMatchHeader { @header("If-Match") ifMatch?: string; }

        @route("/w") interface Widgets {
          @get @route("{id}") read(...WidgetKey, ...Paging, ...IfMatchHeader): Widget;
        }
      `);
      assertContains(
        results["Controllers/WidgetsControllerBase.g.cs"],
        'Read([FromRoute] string id, [FromQuery] int? top, [FromHeader(Name = "If-Match")] string? ifMatch, CancellationToken cancellationToken);',
        "WidgetsControllerBase",
      );
      assertContains(
        results["Services/IWidgetsService.g.cs"],
        "Task<Demo.Models.Widget?> ReadAsync(string id, int? top, string? ifMatch, CancellationToken cancellationToken);",
        "IWidgetsService",
      );
      deepStrictEqual(modelFiles(results), ["Widget.g.cs"]);
    });
  });
});
