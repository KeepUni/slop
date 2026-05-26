const fs = require("node:fs");

const file = process.argv[2];
const kind = process.argv[3];
const N = Number(process.argv[4] || 10);
if (!file || !kind) {
  console.error("usage: node sample-findings.cjs <slp-json> <kind> [N]");
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(file, "utf8"));
const rootDir = String(d.rootDir || "").replace(/\\/g, "/");

function stripRoot(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  if (norm.startsWith(rootDir)) return norm.slice(rootDir.length + 1);
  return norm;
}

const items = (d.issues || []).filter((i) => i.kind === kind);
const insights = (d.insights || []).filter((i) => i.kind === kind);
const all = items.length > 0 ? items : insights;
if (all.length === 0) {
  console.log(`no findings of kind "${kind}"`);
  process.exit(0);
}

const step = Math.max(1, Math.floor(all.length / N));
const sample = [];
for (let i = 0; i < all.length && sample.length < N; i += step) sample.push(all[i]);

console.log(`Sampled ${sample.length} of ${all.length} findings of kind "${kind}":`);
console.log("");

for (let idx = 0; idx < sample.length; idx++) {
  const s = sample[idx];
  const num = `#${idx + 1}`.padEnd(4);
  console.log(num + describe(s));
  console.log("");
}

function describe(s) {
  switch (s.kind) {
    case "duplicate": {
      const head = `${stripRoot(s.primary.file)}:${s.primary.line}` +
        (s.primary.endLine && s.primary.endLine !== s.primary.line ? `-${s.primary.endLine}` : "");
      const more = s.matches
        .map((m) => "        ~ " + stripRoot(m.file) + ":" + m.line +
          (m.endLine && m.endLine !== m.line ? "-" + m.endLine : ""))
        .join("\n");
      return head + "\n" + more + "\n     " +
        Math.round(s.similarity * 100) + "% similar — " + String(s.preview).slice(0, 90) +
        "\n     confidence: " + s.confidence.toFixed(2);
    }
    case "dead-code":
    case "unused-export":
      return stripRoot(s.location.file) + ":" + s.location.line +
        "\n     " + s.symbolKind + " " + s.symbol +
        "\n     confidence: " + s.confidence.toFixed(2);
    case "empty-wrapper":
      return stripRoot(s.location.file) + ":" + s.location.line +
        "\n     " + s.outerName + " -> " + s.innerCall +
        "\n     confidence: " + s.confidence.toFixed(2);
    case "useless-type-predicate":
      return stripRoot(s.location.file) + ":" + s.location.line +
        "\n     " + s.predicateName + " collapses to: " + s.collapsesTo +
        "\n     confidence: " + s.confidence.toFixed(2);
    case "same-shape-types":
      return stripRoot(s.primary.file) + ":" + s.primary.line +
        "\n     names: " + [s.primaryName, ...s.matchNames].join(", ") +
        "\n     fields: " + s.fieldCount +
        "\n     confidence: " + s.confidence.toFixed(2);
    case "orphaned-file":
      return stripRoot(s.file) +
        "\n     dead symbols: " + s.deadSymbols.length +
        "\n     confidence: " + s.confidence.toFixed(2);
    default:
      return JSON.stringify(s);
  }
}
