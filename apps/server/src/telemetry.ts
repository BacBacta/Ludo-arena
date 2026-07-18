// Beta instrumentation (SEASON_PASS_SPEC.md §13): emit one structured line per
// economy-relevant event so the simulator's hypotheses can be recalibrated on
// real data — ticket faucet/sink volumes, crowns/day, tier reached, claim rate,
// freeroll participation. Deliberately dead simple: single-line JSON to stdout,
// scraped from Fly logs. No external pipeline, no PII — players are the OPAQUE
// public pid (never a raw wallet), and logging can never throw into a game path.
import { pidFor } from './store/index.js';

export function telemetry(event: string, data: Record<string, unknown>): void {
  try {
    console.log('[telemetry] ' + JSON.stringify({ ev: event, ts: new Date().toISOString(), ...data }));
  } catch {
    /* logging must never disrupt a match */
  }
}

/** Opaque per-player id for telemetry (the same hash as the public profile pid),
 *  so events can be aggregated per player/day without exposing any wallet. */
export function tpid(playerId: string): string {
  return pidFor(playerId);
}
