p = 'src/lib/engine.ts'
s = open(p).read()
if 'const [existing] = await db' in s:
    s = s.replace('''    const [existing] = await db
      .select({
        id: predictions.id,
        runId: predictions.runId,
        outcome: predictions.outcome,
      })
      .from(predictions)
      .where(eq(predictions.dedupeKey, key))
      .limit(1);''', '''    const [existing] = await db
      .select({
        id: predictions.id,
        runId: predictions.runId,
        outcome: predictions.outcome,
        finalScore: predictions.finalScore,
      })
      .from(predictions)
      .where(eq(predictions.dedupeKey, key))
      .limit(1);''')
open(p, 'w').write(s)
print("engine finishrun patched.")
