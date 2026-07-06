import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emitWithDiagnostics } from "./host.js";

describe("csharp emitter - emitter options", () => {
  describe("templates option", () => {
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
});
