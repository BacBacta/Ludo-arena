import { describe, expect, it } from 'vitest';
import { DICE_SKINS, skinById, skinSound } from '../src/lib/diceSkins';

// THE BUG. `sound` was hand-set on the six original premium dice. The eight
// SEASON dice added later are real WebGL dice with real materials — and every
// one of them fell through to the generic plastic throw, because nobody set
// `sound` on them. Invisible in review: every call site read `skin.sound` and
// looked perfectly correct. The gap was in the DATA, not the wiring.
//
// So this suite asserts the RULE ("a 3D die always has a voice"), never a list
// of ids — a list would have passed just as happily on the broken catalogue.

describe('every 3D die has a roll sound', () => {
  it('no skin with a premium material falls back to the default throw', () => {
    const mute = DICE_SKINS.filter((s) => s.material && !skinSound(s)).map((s) => s.id);
    expect(mute).toEqual([]);
  });

  it('the season dice specifically — the ones the bug silenced', () => {
    const season = DICE_SKINS.filter((s) => s.season && s.material);
    expect(season.length).toBeGreaterThan(0);
    for (const s of season) expect(skinSound(s), `${s.id} is mute`).toBeTruthy();
  });

  it('dice sharing a material share their voice', () => {
    // aurora (irid) is an original with an explicit sound; season-void is irid
    // too and had none — it must now answer with the same material voice.
    expect(skinSound(skinById('season-void'))).toBe(skinSound(skinById('aurora')));
    expect(skinSound(skinById('season-solar'))).toBe(skinSound(skinById('gold')));
    expect(skinSound(skinById('season-frost'))).toBe(skinSound(skinById('crystal')));
  });
});

describe('what must NOT change', () => {
  it('an explicit sound still wins over the material default', () => {
    for (const s of DICE_SKINS.filter((s) => s.sound)) expect(skinSound(s)).toBe(s.sound);
  });

  it('a flat CSS die keeps the default throw — silence is correct here', () => {
    expect(skinSound(skinById('classic'))).toBeUndefined();
    expect(skinSound(skinById('emerald'))).toBeUndefined();
    // season-verdant is the one season die with no material: flat, so default.
    expect(skinSound(skinById('season-verdant'))).toBeUndefined();
  });

  it('the six original premium voices are unchanged', () => {
    expect(skinSound(skinById('gold'))).toBe('gold');
    expect(skinSound(skinById('obsidian'))).toBe('obsidian');
    expect(skinSound(skinById('crystal'))).toBe('crystal');
    expect(skinSound(skinById('aurora'))).toBe('aurora');
    expect(skinSound(skinById('neon'))).toBe('neon');
    expect(skinSound(skinById('ember'))).toBe('ember');
  });
});

// Every resolved sound must name a sample that actually ships, or the die goes
// SILENT — a worse failure than the default throw, and one no type can catch.
describe('every resolved sound maps to a shipped sample', () => {
  const SHIPPED = ['gold', 'obsidian', 'crystal', 'aurora', 'neon', 'ember'];

  it('no die resolves to a sample that does not exist in public/sfx/dice', () => {
    const missing = DICE_SKINS
      .map((s) => ({ id: s.id, snd: skinSound(s) }))
      .filter((x) => x.snd && !SHIPPED.includes(x.snd));
    expect(missing).toEqual([]);
  });
});
