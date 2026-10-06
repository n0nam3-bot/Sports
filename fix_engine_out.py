import re
p = 'src/lib/engine.ts'
s = open(p).read()

# Fix STRATEGA
if 'let strategaDetails =' not in s:
    s = s.replace('const strategaTarget = llmEnabled && stratega ? targetFor(stratega.id, keys, true) : null;',
                  'const strategaTarget = llmEnabled && stratega ? targetFor(stratega.id, keys, true) : null;\n    let strategaDetails = "no LLM used";')
    s = s.replace('const survived = new Set((out?.verdicts ?? []).map((v) => v.id));',
                  'const survived = new Set((out?.verdicts ?? []).map((v) => v.id));\n      strategaDetails = out?.verdicts?.map((v: any) => `#${v.id} (conf ${v.confidence}): ${v.thesis}`).join(" | ") || "no detailed theses returned";')
    
# Remove the old bad line
s = re.sub(r'const strategaDetails = typeof out.*?\n', '', s)

# Fix CONTRARIAN
if 'let contraDetails =' not in s:
    s = s.replace('const contraTarget = llmEnabled && contrarian ? targetFor(contrarian.id, keys, true) : null;',
                  'const contraTarget = llmEnabled && contrarian ? targetFor(contrarian.id, keys, true) : null;\n    let contraDetails = "no LLM used";')
    s = s.replace('''        if (adt.verdict === "DISCOUNT") {
          c.discount = adt.why || "discounted";
          c.confidence = Math.max(45, c.confidence - 5);
        }
      }
    }''', '''        if (adt.verdict === "DISCOUNT") {
          c.discount = adt.why || "discounted";
          c.confidence = Math.max(45, c.confidence - 5);
        }
      }
      contraDetails = out?.audits?.filter((a: any) => a.verdict !== "CONFIRM").map((a: any) => `#${a.id} ${a.verdict}: ${a.why}`).join(" | ") || "all confirmed";
    }''')

# Remove the old bad line
s = re.sub(r'const contraDetails = typeof out.*?\n', '', s)

open(p, 'w').write(s)
print("Engine scope fixed.")
