const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync("slp-profile.cpuprofile", "utf8"));

const byModule = new Map();
for (const n of p.nodes) {
  const url = n.callFrame.url || "(builtin)";
  let mod;
  if (url.includes("node_modules")) {
    const after = url.split("node_modules/").pop();
    mod = after.startsWith("@") ? after.split("/").slice(0, 2).join("/") : after.split("/")[0];
  } else if (url.includes("/dist/") || url.includes("/src/")) {
    mod = "(slp)";
  } else if (url === "") {
    mod = "(builtin)";
  } else if (url.startsWith("node:")) {
    mod = "node:" + url.slice(5).split("/")[0];
  } else {
    mod = url;
  }
  byModule.set(mod, (byModule.get(mod) || 0) + n.hitCount);
}

let totalTicks = 0;
for (const v of byModule.values()) totalTicks += v;
console.log("TOTAL ticks: " + totalTicks);
console.log("");

const sorted = [...byModule.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted.slice(0, 20)) {
  const pct = ((v / totalTicks) * 100).toFixed(1);
  console.log(String(v).padStart(6) + "  " + pct.padStart(5) + "%  " + k);
}
