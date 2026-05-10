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
  // Preserve actual emitted keys, but provide backward-compatible lookup for
  // tests that reference model/interface/enum files at output root.
  // Example: key lookup "User.g.cs" resolves to "Models/User.g.cs" when the
  // file exists there and no explicit models-output-dir override is provided.
  const hasExplicitModelsDir = options?.["models-output-dir"] !== undefined;
  if (hasExplicitModelsDir) {
    return result;
  }

  return new Proxy(result, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        const modelPath = `Models/${prop}`;
        if (modelPath in target) {
          return Reflect.get(target, modelPath, receiver);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Record<string, string>;
}
