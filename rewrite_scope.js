const fs = require('fs');
let s = fs.readFileSync('src/lib/engine.ts', 'utf8');

// STRATEGA
s = s.replace(/const strategaTarget = [^;]+;/, 'const strategaTarget = llmEnabled && stratega ? targetFor(stratega.id, keys, true) : null;\n    let strategaDetails = "no LLM used";');

// Clean up any extra inserts
s = s.replace(/strategaDetails = out\?\.verdicts\?\.map.*?\n/g, '');
s = s.replace('const survived = new Set((out?.verdicts ?? []).map((v) => v.id));', 'const survived = new Set((out?.verdicts ?? []).map((v) => v.id));\n      strategaDetails = out?.verdicts?.map((v: any) => `#${v.id} (conf ${v.confidence}): ${v.thesis}`).join(" | ") || "no detailed theses returned";');

// CONTRARIAN
s = s.replace(/const contraTarget = [^;]+;/, 'const contraTarget = llmEnabled && contrarian ? targetFor(contrarian.id, keys, true) : null;\n    let contraDetails = "no LLM used";');

s = s.replace(/contraDetails = out\?\.audits\?\.filter.*?\n/g, '');
s = s.replace('c.confidence = Math.max(45, c.confidence - 5);\n        }\n      }\n    }', 'c.confidence = Math.max(45, c.confidence - 5);\n        }\n      }\n      contraDetails = out?.audits?.filter((a: any) => a.verdict !== "CONFIRM").map((a: any) => `#${a.id} ${a.verdict}: ${a.why}`).join(" | ") || "all confirmed";\n    }');

fs.writeFileSync('src/lib/engine.ts', s);
