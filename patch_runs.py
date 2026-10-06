p = 'src/app/api/runs/route.ts'
s = open(p).read()
s = s.replace('''      return {
        ...r,
        predictions: [...fresh, ...carried].sort((a, b) => b.confidence - a.confidence),
      };''', '''      return {
        ...r,
        isViewerRun: r.ownerId === adminOwnerId() && adminOwnerId() !== "",
        predictions: [...fresh, ...carried].sort((a, b) => b.confidence - a.confidence),
      };''')

if 'includeEvents' not in s:
    s = s.replace('''    markets?: string[];
  } | null;''', '''    markets?: string[];
    includeEvents?: string[];
  } | null;''')
    s = s.replace('''      sports: body.sports.slice(0, 8),
      markets: Array.isArray(body.markets) ? body.markets.slice(0, 20) : [],''', '''      sports: body.sports.slice(0, 8),
      includeEvents: Array.isArray(body.includeEvents) ? body.includeEvents.slice(0, 400) : [],
      markets: Array.isArray(body.markets) ? body.markets.slice(0, 20) : [],''')

open(p, 'w').write(s)
print("runs route patched.")
