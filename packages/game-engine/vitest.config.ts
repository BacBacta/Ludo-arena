import { defineConfig } from 'vitest/config';

// Coverage for the pure rules engine (Phase 1, R-COV-1). types.ts is
// declarations only (no executable statements) so it is excluded — it would
// otherwise report 0/0 and drag the headline number down artificially.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/index.ts'],
      reporter: ['text', 'json-summary'],
      // Statements/lines/functions sit at 100%. Branches are held at 88 (actual
      // ~89): the shortfall is entirely defensive `?? -1` / `if (!row)` guards in
      // pickAutoMove(4)/absCell that are UNREACHABLE through the public API — a
      // missing row makes legalMoves return [], so the guard's other arm can't be
      // reached with real inputs. Covering them would mean asserting on impossible
      // states, so the threshold documents the limit rather than chasing dead arms.
      thresholds: {
        statements: 90,
        branches: 88,
        functions: 90,
        lines: 90,
      },
    },
  },
});
