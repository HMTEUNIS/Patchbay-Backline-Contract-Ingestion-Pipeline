/**
 * Portable source-PDF layout.
 *
 * The stored path has no host, bucket, or URL. The demo app prefixes whatever
 * folder these files are copied into. Hosting the PDFs from a Next.js app is
 * a demo shortcut; a production deploy should serve them from a private store.
 */

import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_NAME = /^((?:FBR|PB)-(A|C)-\d+)_([a-z0-9-]+)\.pdf$/i;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Folder of copied PDFs, ready to drop into the demo app. */
export function documentsRoot(): string {
  return resolve(ROOT, "documents");
}

/**
 * Path stored on the contract and on every clause from that PDF.
 * `nova-hale/amendments/PB-A-0001_nova-hale.pdf`
 */
export function sourceRelativePath(fileName: string): string {
  const match = FILE_NAME.exec(fileName);
  if (!match) return `unsorted/${fileName}`;
  const kind = match[2]?.toUpperCase() === "A" ? "amendments" : "base";
  const artist = match[3]?.toLowerCase() ?? "unknown";
  return `${artist}/${kind}/${fileName}`;
}

/** Copy one PDF into the document folder. An existing copy is left in place. */
export async function copySourcePdf(destRoot: string, sourceFile: string, relativePath: string): Promise<string> {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error(`Refusing source path ${relativePath}`);
  }
  const destination = join(destRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await copyFile(sourceFile, destination, constants.COPYFILE_EXCL);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code !== "EEXIST") throw err;
  }
  return relativePath;
}
