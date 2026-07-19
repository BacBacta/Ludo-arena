import { describe, expect, it } from 'vitest';
import { applyHelloCosmetics, type SessionCosmetics } from '../src/sessionCosmetics.js';

describe('applyHelloCosmetics (cosmetics relay — resumed vs fresh hello)', () => {
  it('a resumed session picks up ALL cosmetics from a cosmetic-carrying hello', () => {
    // The reported bug: the game hello always RESUMES (the lobby syncLobby hello
    // mints the token first), and the resumed path refreshed only frame/avatar —
    // so pawn skin / entrance / victory never reached the opponent.
    const session: SessionCosmetics = {}; // minted by an earlier cosmetic-less hello
    applyHelloCosmetics(session, {
      frame: 'gold',
      avatar: 'av-1',
      diceSkin: 'crystal',
      tokenSkin: 'tok-kente',
      entranceFx: 'fx-sparkle',
      victoryFx: 'vx-fireworks',
    });
    expect(session).toEqual({
      frame: 'gold',
      avatar: 'av-1',
      diceSkin: 'crystal',
      tokenSkin: 'tok-kente',
      entranceFx: 'fx-sparkle',
      victoryFx: 'vx-fireworks',
    });
  });

  it('a later cosmetic-less hello (another syncLobby) does NOT wipe equipped cosmetics', () => {
    const session: SessionCosmetics = { tokenSkin: 'tok-gilded', entranceFx: 'fx-goldrain', victoryFx: 'vx-crown', frame: 'ruby' };
    applyHelloCosmetics(session, {}); // syncLobby carries none
    expect(session).toEqual({ tokenSkin: 'tok-gilded', entranceFx: 'fx-goldrain', victoryFx: 'vx-crown', frame: 'ruby' });
  });

  it('a new value overwrites the old (re-equip mid-session)', () => {
    const session: SessionCosmetics = { tokenSkin: 'tok-kente' };
    applyHelloCosmetics(session, { tokenSkin: 'tok-lion' });
    expect(session.tokenSkin).toBe('tok-lion');
  });

  it('a fresh session (all undefined) is equivalent to a direct assignment', () => {
    const session: SessionCosmetics = {};
    applyHelloCosmetics(session, { frame: 'none', avatar: 'none' });
    expect(session).toEqual({ frame: 'none', avatar: 'none' });
    // the phase-1/2 fields stay absent (undefined), as sent
    expect(session.tokenSkin).toBeUndefined();
  });
});
