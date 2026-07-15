/**
 * Editable-profile client bits (E-social): the country picker list + the local
 * store of the player's chosen name/flag. The chosen identity is sent in every
 * hello; the server sanitizes + persists it and echoes the effective value back
 * (a filtered name may differ from what was typed), so localStorage is only the
 * optimistic cache, never the source of truth.
 */

/** ISO-3166 alpha-2 → flag emoji (two regional-indicator symbols). */
export function codeToFlag(cc: string): string {
  return cc
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Curated country list — the target markets (Africa first) plus the majors.
 *  Flags are derived from the code so the list stays a plain [code, name] table. */
export const COUNTRIES: { code: string; name: string; flag: string }[] = (
  [
    ['CM', 'Cameroon'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'],
    ['CI', "Côte d'Ivoire"], ['SN', 'Senegal'], ['TZ', 'Tanzania'], ['UG', 'Uganda'], ['ET', 'Ethiopia'],
    ['CD', 'DR Congo'], ['MA', 'Morocco'], ['DZ', 'Algeria'], ['EG', 'Egypt'], ['RW', 'Rwanda'],
    ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'], ['AO', 'Angola'], ['ML', 'Mali'], ['BF', 'Burkina Faso'],
    ['BJ', 'Benin'], ['TG', 'Togo'], ['GA', 'Gabon'], ['GN', 'Guinea'], ['NE', 'Niger'],
    ['MZ', 'Mozambique'], ['MW', 'Malawi'], ['BW', 'Botswana'], ['NA', 'Namibia'], ['MG', 'Madagascar'],
    ['US', 'United States'], ['GB', 'United Kingdom'], ['FR', 'France'], ['DE', 'Germany'], ['ES', 'Spain'],
    ['PT', 'Portugal'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['BR', 'Brazil'], ['AR', 'Argentina'],
    ['MX', 'Mexico'], ['CO', 'Colombia'], ['CA', 'Canada'], ['IN', 'India'], ['PK', 'Pakistan'],
    ['BD', 'Bangladesh'], ['ID', 'Indonesia'], ['PH', 'Philippines'], ['VN', 'Vietnam'], ['CN', 'China'],
    ['TR', 'Turkey'], ['SA', 'Saudi Arabia'], ['AE', 'UAE'], ['RU', 'Russia'], ['UA', 'Ukraine'],
  ] as [string, string][]
).map(([code, name]) => ({ code, name, flag: codeToFlag(code) }));

/** The neutral "no country / other" choice, shown first in the picker. */
export const GLOBE_FLAG = '🌍';

const NAME_KEY = 'ludo.profileName';
const FLAG_KEY = 'ludo.profileFlag';

export interface CustomIdentity {
  name?: string;
  flag?: string;
}

export function loadCustomIdentity(): CustomIdentity {
  try {
    return {
      name: localStorage.getItem(NAME_KEY) || undefined,
      flag: localStorage.getItem(FLAG_KEY) || undefined,
    };
  } catch {
    return {};
  }
}

export function saveCustomIdentity(name: string | undefined, flag: string | undefined): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    if (flag) localStorage.setItem(FLAG_KEY, flag);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Pin the FIRST server-assigned NAME so it never changes again. A guest who never
 * edits their profile sends no name in `hello`, and the server derives one from
 * the per-connection session id — a NEW random name every connection. Their
 * friends saw "Kofi" one game and "Thabo" the next while their own screen said
 * something else entirely ("the names differ from one screen to another").
 * Persisting the first assignment makes every later `hello` carry it, and the
 * server honors a client-sent name — one stable name everywhere. A profile edit
 * still overwrites it via saveCustomIdentity.
 *
 * The FLAG is deliberately never pinned here: a flag is a claim about who you
 * are, so it is only ever set by the player choosing one in their profile.
 * Guests keep the neutral globe.
 */
export function adoptServerIdentity(name: string | undefined): void {
  try {
    if (!name || localStorage.getItem(NAME_KEY)) return;
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable */
  }
}
