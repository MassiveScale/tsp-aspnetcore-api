import "@typespec/http";
import "@typespec/versioning";

using Http;
using Versioning;

@versioned(Versions)
@service(#{ title: "Widget Service" })
namespace MassiveScale.Versioned.Api.Example;

enum Versions {
  v1_0: "1.0",
  v1_1: "1.1",
  v2_0: "2.0",
}

model Widget {
  id: string;
  weight: int32;
  color: "red" | "blue";
}

model WidgetList {
  items: Widget[];
}

@error
model Error {
  code: int32;
  message: string;
}

@added(Versions.v2_0)
model AnalyzeResult {
  id: string;
  analysis: string;
}

@route("/widgets")
@tag("Widgets")
interface Widgets {
  /** List widgets */
  @get list(): WidgetList | Error;

  /** Read widgets */
  @get read(@path id: string): Widget | Error;

  /** Create a widget */
  @added(Versions.v1_1)
  @post
  create(@body body: Widget): Widget | Error;

  /** Update a widget */
  @added(Versions.v1_1)
  @patch
  update(
    @path id: string,
    @body body: MergePatchUpdate<Widget>,
  ): Widget | Error;

  /** Delete a widget */
  @added(Versions.v2_0)
  @delete
  delete(@path id: string): void | Error;

  /** Analyze a widget */
  @added(Versions.v2_0)
  @route("{id}/analyze")
  @post
  analyze(@path id: string): AnalyzeResult | Error;
}
