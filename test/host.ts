import { Diagnostic, resolvePath } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { createTester } from "@typespec/compiler/testing";

const baseTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@massivescale/tsp-aspnetcore-api", "@typespec/http", "@typespec/versioning"],
});

export const Tester = baseTester.emit("@massivescale/tsp-aspnetcore-api");

export async function emitWithDiagnostics(
  code: string,
  options?: Record<string, unknown>,
): Promise<[Record<string, string>, readonly Diagnostic[]]> {
  const tester = options ? baseTester.emit("@massivescale/tsp-aspnetcore-api", options) : Tester;
  const [{ outputs }, diagnostics] = await tester.compileAndDiagnose(code);
  return [outputs, diagnostics];
}

export async function emit(
  code: string,
  options?: Record<string, unknown>,
): Promise<Record<string, string>> {
  const [result, diagnostics] = await emitWithDiagnostics(code, options);
  expectDiagnosticEmpty(diagnostics);
  return result;
}
