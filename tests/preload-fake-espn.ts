/**
 * Preload for running the REAL app against a fake ESPN (visual / manual testing only):
 *   NODE_OPTIONS="--import tsx --import ./tests/preload-fake-espn.ts" next start
 * The fake "phase" (pre-game vs final) follows the contents of /tmp/fake-phase,
 * so a running server can have its games "finish" without a restart.
 */
import { readFileSync } from "node:fs";
import { installFakeEspn, newState } from "./fake-espn";

const D = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const state = newState(D);
Object.defineProperty(state, "phase", {
  get() {
    try {
      return readFileSync("/tmp/fake-phase", "utf8").trim() === "final" ? "final" : "pre";
    } catch {
      return "pre";
    }
  },
  set() {},
});
installFakeEspn(state);
console.log(`[fake-espn] installed for ${D}`);
