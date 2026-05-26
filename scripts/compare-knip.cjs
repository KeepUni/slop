const fs = require("node:fs");

const slopFile = process.argv[2];
const knipFile = process.argv[3];
if (!slopFile || !knipFile) {
  console.error("usage: node compare-knip.cjs <slp-json> <knip-json>");
  process.exit(1);
}

const slop = JSON.parse(fs.readFileSync(slopFile, "utf8"));
const knip = JSON.parse(fs.readFileSync(knipFile, "utf8"));

function relFile(f) {
  return String(f || "").replace(/\\/g, "/");
}

const slopFindings = new Set();
const slopOrphanFiles = new Set();

for (const i of slop.issues) {
  if (i.kind === "dead-code" || i.kind === "unused-export") {
    slopFindings.add(`${relFile(i.relativeFile)}::${i.symbol}`);
  }
}
for (const i of slop.insights) {
  if (i.kind === "orphaned-file") {
    slopOrphanFiles.add(relFile(i.relativeFile));
  }
}

const knipFindings = new Set();
const knipOrphanFiles = new Set();
for (const f of knip.files || []) {
  knipOrphanFiles.add(relFile(f));
}
for (const issue of knip.issues || []) {
  const file = relFile(issue.file);
  for (const e of issue.exports || []) knipFindings.add(`${file}::${e.name}`);
  for (const e of issue.types || []) knipFindings.add(`${file}::${e.name}`);
}

const sharedSymbol = [];
const onlyKnipSymbol = [];
const onlySlopSymbol = [];

for (const k of knipFindings) {
  const file = k.split("::")[0];
  if (slopFindings.has(k)) {
    sharedSymbol.push(k);
  } else if (slopOrphanFiles.has(file)) {
    sharedSymbol.push(`${k} (rolled into orphan)`);
  } else {
    onlyKnipSymbol.push(k);
  }
}
for (const s of slopFindings) {
  const file = s.split("::")[0];
  if (!knipFindings.has(s) && !knipOrphanFiles.has(file)) {
    onlySlopSymbol.push(s);
  }
}

const sharedOrphan = [];
const onlyKnipOrphan = [];
const onlySlopOrphan = [];
for (const f of knipOrphanFiles) {
  if (slopOrphanFiles.has(f)) sharedOrphan.push(f);
  else onlyKnipOrphan.push(f);
}
for (const f of slopOrphanFiles) {
  if (!knipOrphanFiles.has(f)) onlySlopOrphan.push(f);
}

console.log("=== Dead-code / unused-export findings ===");
console.log(`shared          : ${sharedSymbol.length}`);
console.log(`only knip       : ${onlyKnipSymbol.length}`);
console.log(`only slp        : ${onlySlopSymbol.length}`);
console.log("");
console.log("=== Orphan-file findings ===");
console.log(`shared          : ${sharedOrphan.length}`);
console.log(`only knip       : ${onlyKnipOrphan.length}`);
console.log(`only slp        : ${onlySlopOrphan.length}`);
console.log("");

const SAMPLE = 12;
function printSample(title, items) {
  if (items.length === 0) return;
  console.log(`--- ${title} ---`);
  for (const f of items.slice(0, SAMPLE)) console.log(`   ${f}`);
  if (items.length > SAMPLE) console.log(`   ... +${items.length - SAMPLE} more`);
  console.log("");
}

printSample("Sample: only knip finds these symbols", onlyKnipSymbol);
printSample("Sample: only slp finds these symbols", onlySlopSymbol);
printSample("Sample: only knip flags these orphan files", onlyKnipOrphan);
printSample("Sample: only slp flags these orphan files", onlySlopOrphan);
