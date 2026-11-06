// Is a rewrite in the page's language? Rewrites are a title, a description and an H1: too short for a statistical
// detector (tinyld calls "Humvee Scale Model | ARCH GRAPHIC" Hindi). Two checks that hold on short text instead: the
// script its letters are written in, and, among Latin-script languages, which one's function words it uses.

const SCRIPTS: [RegExp, RegExp][] = [
  [/^(ar|fa|ur|ps|ku|sd|ug)$/, /\p{Script=Arabic}/u],
  [/^(he|yi)$/, /\p{Script=Hebrew}/u],
  [/^(ru|uk|be|bg|mk|sr|kk|ky|mn|tg)$/, /\p{Script=Cyrillic}/u],
  [/^(zh|ja)$/, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  [/^ko$/, /\p{Script=Hangul}/u],
  [/^(hi|mr|ne)$/, /\p{Script=Devanagari}/u],
  [/^th$/, /\p{Script=Thai}/u],
  [/^el$/, /\p{Script=Greek}/u],
  [/^bn$/, /\p{Script=Bengali}/u],
  [/^ta$/, /\p{Script=Tamil}/u],
];
const LATIN = /\p{Script=Latin}/u;

/** A few frequent words of each Latin-script language that the others rarely use. */
const FUNCTION_WORDS: Record<string, Set<string>> = {
  en: new Set(["the", "and", "for", "with", "your", "our", "you", "from", "in", "of", "to", "get", "is", "are"]),
  fr: new Set(["le", "la", "les", "des", "et", "pour", "avec", "votre", "nos", "vos", "du", "un", "une", "est", "à"]),
  es: new Set(["el", "los", "las", "y", "para", "con", "su", "sus", "nuestro", "nuestros", "del", "una", "es", "en"]),
  de: new Set(["der", "die", "das", "und", "für", "mit", "ihr", "ihre", "unsere", "ein", "eine", "ist", "von", "zu"]),
  it: new Set(["il", "gli", "e", "per", "con", "tuo", "tua", "nostro", "nostri", "dei", "una", "è", "di", "della"]),
  pt: new Set(["o", "os", "as", "e", "para", "com", "seu", "sua", "nosso", "nossos", "do", "da", "uma", "é"]),
  nl: new Set(["de", "het", "en", "voor", "met", "uw", "jouw", "onze", "een", "is", "van", "naar"]),
};

const primary = (l: string) => l.trim().toLowerCase().split(/[-_]/)[0];

/**
 * Why `text` is not in `lang`, or null when it is or this cannot tell. `lang` is the page's detected language; an
 * unknown one is never a mismatch. Brand names in Latin letters on an Arabic page are fine: half the letters is enough.
 */
export function languageMismatch(text: string, lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = primary(lang);
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 3) return null;
  const share = (re: RegExp) => letters.filter((c) => re.test(c)).length / letters.length;
  const own = SCRIPTS.find(([langs]) => langs.test(l));
  if (own) return share(own[1]) >= 0.5 ? null : `written in another script than the page's language (${l})`;
  // A Latin-script page language: the rewrite must be mostly Latin letters…
  if (share(LATIN) < 0.5) return `written in another script than the page's language (${l})`;
  // …and, where the function words say anything, use the page language's, not another's.
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = (set: Set<string>) => words.filter((w) => set.has(w)).length;
  const mine = FUNCTION_WORDS[l] ? score(FUNCTION_WORDS[l]) : null;
  const best = Object.entries(FUNCTION_WORDS)
    .filter(([k]) => k !== l)
    .map(([k, set]) => [k, score(set)] as const)
    .sort((a, b) => b[1] - a[1])[0];
  if (mine !== null && best[1] >= 2 && best[1] > mine * 2) return `reads as ${best[0]}, not the page's language (${l})`;
  return null;
}
