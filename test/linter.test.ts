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

  // Note: @serverName's own validator (decorators.ts) already rejects a bare
  // reserved keyword like "class" with "invalid-server-name" before this
  // lint rule ever runs, so a fine parameter cannot actually be renamed INTO
  // an unescaped reserved word through the public @serverName API — that
  // direction is structurally prevented upstream. The verbatim-escaped form
  // (e.g. "@class") IS accepted by @serverName, and correctly must NOT be
  // flagged here since "@class" is valid, non-colliding C# — this proves the
  // rule tracks the actual emitted identifier (via getServerName) rather
  // than blindly re-deriving it from the original TypeSpec name.
  it("does not flag a parameter renamed to an escaped reserved keyword by @serverName", async () => {
    const runner = await baseTester.createInstance();
    const tester = createLinterRuleTester(
      runner,
      reservedParameterNameRule,
      "@massivescale/tsp-aspnetcore-api",
    );
    await tester
      .expect(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using Http;

        @service(#{title: "Demo" })
        namespace Demo;

        @route("/items")
        op getItem(@query @serverName("@class") id: string): string;
      `,
      )
      .toBeValid();
  });

  it("does not flag a reserved-keyword parameter renamed away by @serverName", async () => {
    const runner = await baseTester.createInstance();
    const tester = createLinterRuleTester(
      runner,
      reservedParameterNameRule,
      "@massivescale/tsp-aspnetcore-api",
    );
    await tester
      .expect(
        `
        import "@massivescale/tsp-aspnetcore-api";
        import "@typespec/http";
        using MassiveScale.AspNetCoreApi;
        using Http;

        @service(#{title: "Demo" })
        namespace Demo;

        @route("/items")
        op getItem(@query @serverName("clazz") class: string): string;
      `,
      )
      .toBeValid();
  });
});
