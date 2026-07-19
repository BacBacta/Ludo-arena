/**
 * Apply the equipped cosmetics carried by a `hello` onto a session — the SINGLE
 * place both hello paths (fresh session AND resumed session) share, so they can
 * never again drift. A resumed session used to refresh only frame/avatar and
 * silently dropped the pawn skin / entrance / victory effects, so the opponent
 * never saw them: the lobby's cosmetic-less `syncLobby` hello lands first and
 * mints the sessionToken, which makes the REAL game hello (the one that carries
 * tokenSkin/entranceFx/victoryFx) always take the resumed path.
 *
 * Per-field CONDITIONAL: only overwrite when the hello actually carries a value,
 * so a later cosmetic-less hello (another syncLobby, a keepalive re-hello) never
 * wipes a value an earlier hello set. For a truly fresh session every field
 * starts undefined, so this is equivalent to an unconditional assignment there.
 */
export interface SessionCosmetics {
  frame?: string;
  avatar?: string;
  diceSkin?: string;
  tokenSkin?: string;
  entranceFx?: string;
  victoryFx?: string;
}

export function applyHelloCosmetics(target: SessionCosmetics, msg: SessionCosmetics): void {
  if (msg.frame !== undefined) target.frame = msg.frame;
  if (msg.avatar !== undefined) target.avatar = msg.avatar;
  if (msg.diceSkin !== undefined) target.diceSkin = msg.diceSkin;
  if (msg.tokenSkin !== undefined) target.tokenSkin = msg.tokenSkin;
  if (msg.entranceFx !== undefined) target.entranceFx = msg.entranceFx;
  if (msg.victoryFx !== undefined) target.victoryFx = msg.victoryFx;
}
