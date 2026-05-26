const path = require("node:path");
const fs = require("node:fs");

const file = process.argv[2];
if (!file) {
  console.error("usage: node analyze-findings.cjs <path-to-slp-json>");
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(file, "utf8"));

const insightCounts = {};
for (const i of d.insights) insightCounts[i.kind] = (insightCounts[i.kind] || 0) + 1;
const issueCounts = {};
for (const i of d.issues) issueCounts[i.kind] = (issueCounts[i.kind] || 0) + 1;

console.log("files scanned:", d.filesScanned);
console.log("duration ms:", d.durationMs);
console.log("");
console.log("insights by kind:");
for (const [k, v] of Object.entries(insightCounts).sort((a, b) => b[1] - a[1])) {
  console.log("  " + String(v).padStart(4), k);
}
console.log("");
console.log("issues by kind:");
for (const [k, v] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
  console.log("  " + String(v).padStart(4), k);
}
console.log("");

const orphans = d.insights.filter((i) => i.kind === "orphaned-file");
if (orphans.length > 0) {
  console.log("orphan files (first 20):");
  for (const o of orphans.slice(0, 20)) console.log("   ", o.relativeFile);
}
