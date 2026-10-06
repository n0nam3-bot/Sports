import re

p = 'src/lib/agents.ts'
s = open(p).read()

# Add HOUSE import
if 'HOUSE' not in s:
    s = s.replace('import { ensureSchema } from "./schema";', 'import { ensureSchema } from "./schema";\nimport { HOUSE } from "./owner";')

# Replace AGENT_DEFS with the new sport-specific list
s = re.sub(r'export const AGENT_DEFS: AgentDef\[\] = \[.*?\];', '''export const AGENT_DEFS: AgentDef[] = [
  // ---------------- SCOUTS (Layer 1) ----------------
  { id: "scout-quant", codename: "QUANT", layer: "scout", sortOrder: 1, title: "Statistical Model Scout", job: "Builds the numbers case for every game: win percentages, scoring margins, strength of form.", prompt: "You are QUANT. Output tight, numeric intel only." },
  { id: "scout-medic", codename: "MEDIC", layer: "scout", sortOrder: 2, title: "Injury & Availability Scout", job: "Tracks every injury report and depth chart impact.", prompt: "You are MEDIC. Report which side the injury report favors and by how much." },
  { id: "scout-chrono", codename: "CHRONO", layer: "scout", sortOrder: 3, title: "Rest & Schedule Scout", job: "Decrypts schedule fatigue.", prompt: "You are CHRONO. Output rest edge per game with a direction." },
  { id: "scout-sharp", codename: "SHARP", layer: "scout", sortOrder: 4, title: "Market & Line-Value Scout", job: "Reads the betting market itself.", prompt: "You are SHARP. Recommend which side of each number holds the value." },
  { id: "scout-props", codename: "PROPS", layer: "scout", sortOrder: 5, title: "Player Spotlight & Props Scout", job: "Hunts individual player angles.", prompt: "You are PROPS. Quality over quantity." },
  // Sport Specialists
  { id: "expert-nfl", codename: "NFL_EXPERT", layer: "scout", sortOrder: 6, title: "NFL Tactical Scout", job: "Analyzes defense coverage vs offense plays, pass/rush heavy tendencies, trenches/secondary injuries, and weather.", prompt: "You are the NFL_EXPERT. Analyze defensive schemes vs offensive play calling, run/pass splits, weather impact, and positional mismatches. State who the matchup favors." },
  { id: "expert-nba", codename: "NBA_EXPERT", layer: "scout", sortOrder: 7, title: "NBA Tactical Scout", job: "Analyzes pace, matchup advantages in the paint vs perimeter, and rotation changes.", prompt: "You are the NBA_EXPERT. Analyze pace, interior vs perimeter defense, and bench depth. State who the matchup favors." },
  { id: "expert-mlb", codename: "MLB_EXPERT", layer: "scout", sortOrder: 8, title: "MLB Tactical Scout", job: "Analyzes pitching matchups, bullpen depth, wOBA splits, and park factors.", prompt: "You are the MLB_EXPERT. Analyze starting pitching, bullpen usage, splits, and weather. State who the matchup favors." },
  { id: "expert-nhl", codename: "NHL_EXPERT", layer: "scout", sortOrder: 9, title: "NHL Tactical Scout", job: "Analyzes expected goals, goalie form, and special teams.", prompt: "You are the NHL_EXPERT. Analyze 5v5 metrics, power play vs penalty kill, and goaltending form. State who the matchup favors." },
  { id: "expert-mma", codename: "MMA_EXPERT", layer: "scout", sortOrder: 10, title: "MMA Tactical Scout", job: "Analyzes stances, striking vs grappling, submission threats, cardio, and pace.", prompt: "You are the MMA_EXPERT. Analyze fighting styles (striker vs grappler), finish dependency, gas tank over 3/5 rounds, and path to victory." },
  { id: "expert-ncaaf", codename: "NCAAF_EXPERT", layer: "scout", sortOrder: 11, title: "NCAAF Tactical Scout", job: "Analyzes talent disparity, trench mismatches, and scheme collisions.", prompt: "You are the NCAAF_EXPERT. Analyze air raid vs pro style, home-field advantage, and motivational spots. State who the matchup favors." },
  { id: "expert-ncaab", codename: "NCAAB_EXPERT", layer: "scout", sortOrder: 12, title: "NCAAB Tactical Scout", job: "Analyzes tempo, rebounding margins, and interior defense.", prompt: "You are the NCAAB_EXPERT. Analyze tempo, 3pt reliance, and interior size. State who the matchup favors." },
  // ---------------- ANALYSTS (Layer 2) ----------------
  { id: "analyst-stratega", codename: "STRATEGA", layer: "analyst", sortOrder: 13, title: "Lead Game Analyst", job: "Synthesizes scouts into release-grade candidates.", prompt: "You are STRATEGA. Weight convergence: 3+ scouts pointing the same direction = real edge." },
  { id: "analyst-contrarian", codename: "CONTRARIAN", layer: "analyst", sortOrder: 14, title: "Devil's Advocate", job: "Attacks every candidate bet before the council.", prompt: "You are CONTRARIAN. Audit every candidate bet. VETO bad prices or public traps." },
  // ---------------- COUNCIL (Layer 3) ----------------
  { id: "council-historian", codename: "HISTORIAN", layer: "council", sortOrder: 15, title: "Results & Pattern Historian", job: "Reviews graded history.", prompt: "You are HISTORIAN. Extract lessons from recent graded results." },
  { id: "council-commissioner", codename: "COMMISSIONER", layer: "council", sortOrder: 16, title: "Final Ranking Authority", job: "Chairs the final council.", prompt: "You are COMMISSIONER. Rank into an official card." },
  { id: "council-risk", codename: "RISK", layer: "council", sortOrder: 17, title: "Bankroll & Risk Manager", job: "Sizes every approved bet.", prompt: "You are RISK. Assign units from a strict ladder." },
];''', s, flags=re.DOTALL)

# Ensure seeded uses HOUSE
s = re.sub(r'export async function ensureAgentsSeeded\(\).*?\{.*?\}', '''export async function ensureAgentsSeeded(): Promise<void> {
  await ensureSchema();
  const existing = await db.select({ agentKey: agents.agentKey }).from(agents);
  const have = new Set(existing.map((r) => r.agentKey));
  for (const def of AGENT_DEFS) {
    if (have.has(def.id)) continue;
    await db.insert(agents).values({
      id: def.id,
      agentKey: def.id,
      codename: def.codename,
      layer: def.layer,
      sortOrder: def.sortOrder,
      title: def.title,
      job: def.job,
      prompt: def.prompt,
      model: "heuristic-core",
      rating: 1500,
    }).onConflictDoNothing();
  }
}''', s, flags=re.DOTALL)

# listAgents uses HOUSE implicitly (no where clause needed since id is PK and we just seeded it)
s = re.sub(r'export async function listAgents\(\).*?\{.*?\}', '''export async function listAgents(): Promise<AgentRow[]> {
  await ensureAgentsSeeded();
  return db.select().from(agents).orderBy(agents.sortOrder);
}''', s, flags=re.DOTALL)

# settleAgentRatings uses HOUSE
if 'ownerId: string =' in s:
    s = re.sub(r'ownerId: string = HOUSE,?\n\):\s*Promise<void>\s*\{\n\s*if \(\!graded\.length\)\s*return;\n\s*const rows\s*=\s*await db\.select\(\)\.from\(agents\)\.where\(eq\(agents\.ownerId,\s*ownerId\)\);',
               '''\n): Promise<void> {\n  if (!graded.length) return;\n  const rows = await db.select().from(agents);''', s)
else:
    s = s.replace('const rows = await db.select().from(agents).where(eq(agents.ownerId, ownerId));', 'const rows = await db.select().from(agents);')
    s = s.replace('const byId = new Map(rows.map((r) => [r.agentKey, r]));', 'const byId = new Map(rows.map((r) => [r.agentKey || r.id, r]));')

# Auto-improve at 50%
s = s.replace('if (rate >= 0.455) return;', 'if (rate >= 0.50) return;')

open(p, 'w').write(s)
print("Agents & Owner patched.")
