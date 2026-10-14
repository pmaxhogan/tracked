// stack-template: scripts/check-ascii@2 0efd0b6fe664
// Fails when any tracked text file contains a non-ASCII byte (long dashes, smart quotes).
//
// Allowlist (stack standard style.ascii-only: "legitimately non-ASCII content needs an
// explicit allowlist"):
//   - SKIP_PREFIXES: captured 1001tracklists pages and API answers, kept byte for byte.
//   - ALLOWED: the glyphs the UI shows on purpose (ellipsis, middle dot, check and cross
//     marks, arrows on buttons, status icons) and accented letters in artist and track
//     names. Dashes, smart quotes and box-drawing lines are never allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SKIP_PREFIXES = ["test/fixtures/"];
// UI glyphs by code point: ellipsis, middle dot, multiplication sign (close buttons),
// check and cross marks, link / scroll / redo / swap / sort arrows, status dots, play
// triangles, warning, no-entry and prohibited signs, music note, thumbs up, Delta and
// Sigma (stat labels), registered sign, guillemets (pager).
const ALLOWED = new Set(
  [
    0x2026, 0x00b7, 0x00d7, 0x2713, 0x2717, 0x2715, 0x2197, 0x2912, 0x2913, 0x21bb, 0x21c4, 0x2191,
    0x2193, 0x2195, 0x25cf, 0x25cb, 0x25b6, 0x25b8, 0x26a0, 0x26d4, 0x266b, 0x1f6ab, 0x1f44d,
    0x0394, 0x03a3, 0x00ae, 0x00ab, 0x00bb, 0x2039, 0x203a,
  ].map((cp) => String.fromCodePoint(cp)),
);
// Latin letters with diacritics (names such as Tiesto with a diaeresis), not x or division.
const isNameLetter = (cp) => cp >= 0xc0 && cp <= 0x17f && cp !== 0xd7 && cp !== 0xf7;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let bad = 0;
for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|ico|jar|keystore|zip)$/i.test(f)) continue;
  if (SKIP_PREFIXES.some((p) => f.startsWith(p))) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80 || ALLOWED.has(ch) || isNameLetter(cp)) continue;
      bad++;
      console.log(
        `${f}:${i + 1}: non-ASCII U+${cp.toString(16).padStart(4, "0")}: ${line.trim().slice(0, 100)}`,
      );
      break;
    }
  });
}
if (bad) {
  console.log(`${bad} non-ASCII line(s)`);
  process.exit(1);
}
console.log(`ascii ok (${files.length} files)`);
