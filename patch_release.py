p = 'src/lib/release.ts'
s = open(p).read()
s = s.replace('version: "3.3.0",\n  name: "Combat Odds + Rerun Fix",', 'version: "4.0.0",\n  name: "Global Fleet & Tactical Experts",')
s = s.replace('modelDropdowns: true,\n    combatModelOdds: true,\n    rerunShowsFullCard: true,\n  },', 'modelDropdowns: true,\n    combatModelOdds: true,\n    rerunShowsFullCard: true,\n    globalAgents: true,\n    sportTacticians: true,\n    adminForceImprove: true,\n  },')
open(p, 'w').write(s)
print("Release bumped.")
