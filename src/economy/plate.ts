/**
 * Custom plate text (the `plate-custom` catalog item). Pure functions: validation, the word filter and the wire
 * encoding. Nothing here touches the DOM.
 *
 * Rules (the same code runs when the player types, when a wallet record is loaded, and when another player's
 * presence arrives, so a rejected text can never reach a plate):
 *   - letters A-Z, digits 0-9, space and hyphen only; checked on the raw input, THEN uppercased, so look-alike
 *     Unicode (dotless i, long s, sharp s, full width letters) can never turn into ASCII by case mapping;
 *   - trimmed, runs of spaces collapsed to one, 2 to 8 characters, at least two letters or digits;
 *   - a compact word filter, applied after leetspeak normalisation (0=O 1=I 3=E 4=A 5=S 7=T) with spaces and hyphens
 *     removed, so "F-U-C-K" and "5H1T" are caught. Most words match as a substring; a few short ones that sit inside
 *     ordinary words (ASS in CLASS, COCK in PEACOCK) only match as a whole word or a separate word on the plate.
 *
 * Wire form (inside the "~a.b.c.d.e.f.g" loadout string, as an eighth segment): "x" + two hex digits per character.
 * Hex digits and "x" can never be "." or "~", so the text can not collide with the separators.
 */

export const PLATE_MIN = 2;
export const PLATE_MAX = 8;
/** Drawn when a custom plate has no text yet. */
export const DEFAULT_PLATE_TEXT = 'LATERAL';
export const CUSTOM_PLATE_ID = 'plate-custom';

export type PlateReason = 'empty' | 'short' | 'long' | 'chars' | 'blocked';
export interface PlateCheck {
  readonly ok: boolean;
  /** The normalised text (uppercase, trimmed, single spaces) when ok, else ''. */
  readonly text: string;
  readonly reason: PlateReason | null;
  /** Player-facing message for a rejected text, '' when ok. */
  readonly message: string;
}

const MESSAGES: Readonly<Record<PlateReason, string>> = {
  empty: 'Type 2 to 8 characters.',
  short: 'Too short. Use at least 2 letters or numbers.',
  long: 'Too long. 8 characters at most.',
  chars: 'Use only letters A to Z, numbers, spaces and hyphens.',
  blocked: 'That text is not allowed on a plate. Try something else.',
};
const fail = (reason: PlateReason): PlateCheck => ({ ok: false, text: '', reason, message: MESSAGES[reason] });

/* ------------------------------------------------------------------ word filter */

/** Matched as a substring of the leetspeak-normalised, space-free text. */
const BLOCKED = [
  'FUCK', 'SHIT', 'BITCH', 'CUNT', 'DICK', 'PUSSY', 'WHORE', 'SLUT', 'TWAT', 'WANK', 'PISS', 'BASTARD', 'ASSHOLE', 'DILDO',
  'PORN', 'RAPIST', 'PAEDO', 'PEDO', 'BLOWJOB', 'JIZZ', 'CUMSHOT', 'MOLEST', 'SUICIDE', 'KILLYOU',
  'NIGGER', 'NIGGA', 'NIGGR', 'FAGGOT', 'FAGOT', 'KIKE', 'CHINK', 'WETBACK', 'TRANNY', 'RETARD', 'DYKE',
  'TOWELHEAD', 'BEANER', 'GOLLIWOG', 'NAZI', 'HITLER', 'HEILHIT', 'SIEGHEIL', 'KKK', 'WHITEPOWER',
] as const;
/** Short words that live inside harmless words (CLASS, PEACOCK, GRAPE, SPICE, PAKISTAN): blocked only as the whole plate or as a separate word on it. */
const BLOCKED_WORDS = ['ASS', 'ARSE', 'TIT', 'TITS', 'COCK', 'CUM', 'SEX', 'FAG', 'GOOK', 'COON', 'SPIC', 'PAKI', 'RAPE', 'NAZ'] as const;

const LEET: Readonly<Record<string, string>> = { '0': 'O', '1': 'I', '3': 'E', '4': 'A', '5': 'S', '7': 'T' };
const leet = (text: string): string => text.replace(/[013457]/g, ch => LEET[ch]!);

/** True when the (already normalised, uppercase) text contains a blocked word. */
export function isBlockedPlate(text: string): boolean {
  const spaced = leet(text.toUpperCase());
  const compact = spaced.replace(/[ -]/g, '');
  if (BLOCKED.some(word => compact.includes(word))) return true;
  if (BLOCKED_WORDS.some(word => compact === word)) return true;
  const tokens = spaced.split(/[ -]+/).filter(Boolean);
  return tokens.some(token => (BLOCKED_WORDS as readonly string[]).includes(token));
}

/* ------------------------------------------------------------------ validation */

/** Validates player or wire input. Never throws. */
export function validatePlateText(raw: unknown): PlateCheck {
  if (typeof raw !== 'string') return fail('empty');
  if (raw.length > 64) return fail('long');
  const trimmed = raw.trim();
  if (!trimmed) return fail('empty');
  // Characters are checked BEFORE uppercasing: toUpperCase() maps some non-ASCII letters onto ASCII ones.
  if (!/^[A-Za-z0-9 -]+$/.test(trimmed)) return fail('chars');
  const text = trimmed.replace(/ +/g, ' ').toUpperCase();
  if (text.length > PLATE_MAX) return fail('long');
  if (text.length < PLATE_MIN || (text.match(/[A-Z0-9]/g)?.length ?? 0) < 2) return fail('short');
  if (isBlockedPlate(text)) return fail('blocked');
  return { ok: true, text, reason: null, message: '' };
}

/** The valid normalised text, or null. For untrusted input where the reason does not matter. */
export function cleanPlateText(raw: unknown): string | null {
  const check = validatePlateText(raw);
  return check.ok ? check.text : null;
}

/* ------------------------------------------------------------------ wire encoding */

/** "x" + two uppercase hex digits per character. Contains no "." and no "~". */
export function encodePlateText(text: string): string {
  const clean = cleanPlateText(text);
  if (!clean) return '';
  let out = 'x';
  for (let i = 0; i < clean.length; i++) out += clean.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/** Inverse of encodePlateText. The decoded text is validated again, so a forged segment can not smuggle anything in. */
export function decodePlateText(segment: unknown): string | null {
  if (typeof segment !== 'string' || !/^x(?:[0-9A-F]{2}){1,8}$/.test(segment)) return null;
  let text = '';
  for (let i = 1; i < segment.length; i += 2) text += String.fromCharCode(parseInt(segment.slice(i, i + 2), 16));
  return cleanPlateText(text);
}
