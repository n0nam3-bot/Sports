import re

p = 'src/lib/espn.ts'
s = open(p).read()
s = s.replace('''  // MLB
  HITS: ["hits", "H"],
  STRIKEOUTS: ["strikeouts", "SO", "K"],
};''', '''  // MLB
  HITS: ["hits", "H"],
  WALKS: ["walks", "BB"],
  TOTAL_BASES: ["totalBases", "TB"],
  HOME_RUNS: ["homeRuns", "HR"],
  PITCHER_K: ["strikeouts", "SO", "K"],
  PITCHER_OUTS: ["outsRecorded", "OUTS"],
};''')
open(p, 'w').write(s)

p = 'src/lib/markets.ts'
s = open(p).read()
new_mlb_props = '''  {
    id: "prop_mlb_hits",
    label: "Hits",
    hint: "Batter hits",
    categories: ["player_prop"],
    stats: ["HITS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_walks",
    label: "Walks",
    hint: "Batter walks",
    categories: ["player_prop"],
    stats: ["WALKS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_bases",
    label: "Total Bases",
    hint: "Batter total bases",
    categories: ["player_prop"],
    stats: ["TOTAL_BASES"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_hr",
    label: "Home Runs",
    hint: "Batter home runs",
    categories: ["player_prop"],
    stats: ["HOME_RUNS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_pitcher_k",
    label: "Pitcher Strikeouts",
    hint: "Pitcher Ks",
    categories: ["player_prop"],
    stats: ["PITCHER_K"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_pitcher_outs",
    label: "Pitcher Outs",
    hint: "Pitcher outs recorded",
    categories: ["player_prop"],
    stats: ["PITCHER_OUTS"],
    sports: ["mlb"],
    group: "props",
  },'''
s = s.replace('// ---- segments ----', new_mlb_props + '\n  // ---- segments ----')
open(p, 'w').write(s)
print("MLB Props added.")
