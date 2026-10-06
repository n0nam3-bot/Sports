import re

p = 'src/lib/engine.ts'
s = open(p).read()
s = s.replace('''const cardioText = m.expRounds > 2.5 ? "Cardio is tested." : "Pace favors early exchanges.";
  const under15 = (m.pFinish * (c.scheduledRounds === 5 ? 0.4 : 0.6) * 100).toFixed(0);
  const mmaExtra = `u1.5 rds prob: ${under15}%. ${cardioText}`;''',
'''const under15 = (m.pFinish * (c.scheduledRounds === 5 ? 0.4 : 0.6) * 100).toFixed(0);
  const mmaExtra = `u1.5 rds prob: ${under15}%.`;''')
open(p, 'w').write(s)
print("Engine patched for mmaExtra.")
