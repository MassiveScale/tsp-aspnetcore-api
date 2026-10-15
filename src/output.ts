/**
 * @module output
 *
 * Single write path for every generated file. Wraps the compiler's `emitFile`
 * so the emitter knows exactly which files it wrote during a run; that list is
 * saved as the cleanup manifest (see {@link ./clean.js}) so the next run can
 * remove precisely those files.
 */

import {
  type EmitFileOptions,
  Program,
  emitFile as compilerEmitFile,
} from "@typespec/compiler";

/** Absolute paths written during the current emit, per program. */
const writtenFiles = new WeakMap<Program, Set<string>>();

/**
 * Writes a generated file via the compiler's `emitFile` and records its path.
 *
 * @param program - The compiled TypeSpec program.
 * @param options - Path and content of the file to write.
 */
export async function emitFile(
  program: Program,
  options: EmitFileOptions,
): Promise<void> {
  let files = writtenFiles.get(program);
  if (!files) {
    files = new Set<string>();
    writtenFiles.set(program, files);
  }
  files.add(options.path);
  await compilerEmitFile(program, options);
}

/**
 * Returns the absolute paths of every file written through {@link emitFile}
 * for `program`, sorted.
 *
 * @param program - The compiled TypeSpec program.
 */
export function getWrittenFiles(program: Program): string[] {
  return [...(writtenFiles.get(program) ?? [])].sort();
}
