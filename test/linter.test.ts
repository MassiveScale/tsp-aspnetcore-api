import { createLinterRuleTester } from "@typespec/compiler/testing";
import { describe, it } from "node:test";
import { reservedParameterNameRule } from "../src/rules/reserved-parameter-name.js";
import { baseTester } from "./host.js";

describe("reserved-parameter-name", () => {
  it("flags a reserved-keyword parameter", async () => {
    const runner = await baseTester.createInstance();
    const tester = createLinterRuleTester(
      runner,
      reservedParameterNameRule,
      "@massivescale/tsp-aspnetcore-api",
    );
    await tester
      .expect(
        `
        import "@typespec/http";
        using Http;

        @service(#{title: "Demo" })
        namespace Demo;

        @route("/items")
        op getItem(@query class: string): string;
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-aspnetcore-api/reserved-parameter-name",
      });
  });

  it("is valid for a normal parameter name", async () => {
    const runner = await baseTester.createInstance();
    const tester = createLinterRuleTester(
      runner,
      reservedParameterNameRule,
      "@massivescale/tsp-aspnetcore-api",
    );
    await tester
      .expect(
        `
        import "@typespec/http";
        using Http;

        @service(#{title: "Demo" })
        namespace Demo;

        @route("/items")
        op getItem(@query id: string): string;
      `,
      )
      .toBeValid();
  });
});
