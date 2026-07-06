// Minimal .env support for the specifier scripts. Real environment variables
// always take precedence over the file.

import { readFile } from "node:fs/promises";

/** Parse dotenv text: KEY=value lines, full-line and unquoted-inline #
 * comments, single/double-quoted values (which may contain #). */
export function parseDotenv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
    if (quote) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // Unquoted: an inline comment starts at whitespace followed by '#'.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** process.env overlaid on the .env file at `path` (missing file is fine). */
export async function loadEnv(path) {
  let fromFile = {};
  try {
    fromFile = parseDotenv(await readFile(path, "utf8"));
  } catch {
    // no .env file — environment variables only
  }
  return { ...fromFile, ...process.env };
}
