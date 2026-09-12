/** Run from the published GitHub Pages repository after building source/. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "source/out");
await fs.access(path.join(output, "index.html"));
// Only generated bundle files are replaced. Source, documentation and Git stay intact.
await fs.rm(path.join(root, "_next"), { recursive: true, force: true });
await fs.cp(output, root, { recursive: true });
await fs.writeFile(path.join(root, ".nojekyll"), "");
console.log("Updated Pages files from source/out. Review and commit the generated changes.");
