import { rename, writeFile } from "node:fs/promises";

/**
 * Write-then-rename so a crash mid-write never leaves a half-written file —
 * draft files double as submit progress journals, so torn writes would
 * corrupt the resume state.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}
