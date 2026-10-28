// Deterministic page text for the fixture site. Every page gets its own title, description and main text from a
// seeded generator over a vocabulary of ordinary English words, so clean pages are unique (no duplicate titles,
// descriptions or text; SimHash far from the near-duplicate threshold) and read as English to the language detector.
// Words that trip content rules ("not found", "404", "lorem", "placeholder", "dolor"...) are not in the vocabulary.

const NOUNS = `garden river window market teacher kitchen engine harbour village forest bridge station letter morning
mountain island valley meadow orchard library museum theatre office factory workshop bakery cottage castle tower
harbor lantern blanket basket bottle candle carpet chimney curtain drawer fence gate hammer ladder mirror needle
pencil pillow pocket ribbon saddle shovel spoon table thread towel wagon wheel whistle anchor arrow barrel bucket
cabin canal cart cellar chapel cliff coast copper cotton county desert ditch farm field glacier grove hedge hill
journey lake lane marsh mill moor oak path pebble pine pond prairie quarry ridge road rock shore slope spring
stream summit swamp timber trail tunnel well willow winter summer autumn harvest weather breeze cloud frost
thunder rainbow sunrise sunset shadow evening midnight season century decade minute hour afternoon holiday
festival concert lecture lesson chapter story poem novel painting sculpture photograph portrait melody rhythm
voice whisper laughter silence courage kindness patience wisdom freedom justice honour memory promise secret
surprise question answer reason method pattern habit custom tradition recipe flavour texture colour surface
corner border centre edge circle square triangle diagram measure weight balance distance height width depth
speed motion signal message notice report record budget market price wage salary profit trade merchant sailor
farmer baker miller weaver tailor carpenter painter singer dancer writer reader student scholar doctor nurse
pilot driver captain soldier guard judge mayor neighbour stranger visitor traveller pioneer explorer inventor
engineer chemist gardener shepherd fisherman hunter climber runner swimmer rider builder keeper owner partner`;

const VERBS = `carries builds follows gathers holds keeps leaves lifts makes mends moves opens paints plants pulls pushes
reaches repairs rests rides rises runs shapes shares shows sings sorts spreads stands steers stirs stores studies
sweeps teaches tells tends travels turns visits walks washes watches weaves welcomes writes answers arranges
borrows brings catches changes chooses cleans collects counts covers crosses cuts delivers describes designs
discovers draws drives explains feeds fills finds fixes folds gives greets grows guides hears hides improves
invites joins knows learns lends listens loads locates measures mixes notices offers orders packs passes places
prepares presents protects provides reads receives records remembers returns saves selects sends serves sets
signs solves starts steadies supplies supports tastes tests thanks ties tracks trims trusts uses values wants`;

const ADJECTIVES = `quiet bright gentle narrow broad steep shallow deep early late warm cool fresh ancient modern simple careful
patient steady sturdy humble proud honest clever curious eager busy calm wild tame rough smooth soft hard heavy
light golden silver wooden stone woollen silken sandy rocky muddy grassy leafy sunny cloudy windy rainy snowy
frosty misty dusty rusty shiny plain fancy famous local distant nearby northern southern eastern western central
coastal rural urban royal humble generous friendly polite brave loyal sincere tidy orderly lively merry cheerful
hopeful thoughtful useful helpful graceful peaceful skilful faithful handsome pleasant fragrant elegant spacious`;

const ADVERBS = `slowly quickly gently carefully quietly brightly calmly eagerly firmly freely gladly kindly loosely neatly
openly patiently plainly proudly rarely safely simply softly steadily warmly wisely boldly briskly evenly fairly`;


const split = (s: string) => s.split(/\s+/).filter(Boolean);
export const VOCAB = { nouns: split(NOUNS), verbs: split(VERBS), adjectives: split(ADJECTIVES), adverbs: split(ADVERBS) };

/** Mulberry32: a small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function sentence(r: () => number): string {
  // Content words only: repeated function words ("the", "and") would be shared by every page and pull every pair of
  // SimHashes together (measured: max pairwise similarity 0.95 with them, over 1,300 pages).
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const clause = () => `${pick(VOCAB.adjectives)} ${pick(VOCAB.nouns)} ${pick(VOCAB.adverbs)} ${pick(VOCAB.verbs)} ${pick(VOCAB.adjectives)} ${pick(VOCAB.nouns)}`;
  const parts = [clause()];
  if (r() < 0.5) parts.push(clause());
  return `${cap(parts.join(", "))}.`;
}

/** About `words` words of English-looking text, deterministic in `key`. */
export function paragraph(key: string, words = 240): string {
  const r = rng(seedOf(key));
  const out: string[] = [];
  let n = 0;
  while (n < words) {
    const s = sentence(r);
    out.push(s);
    n += s.split(" ").length;
  }
  return out.join(" ");
}

/** A short topic for a page: two or three vocabulary words, unique per key in practice. */
export function topic(key: string): string {
  const r = rng(seedOf(`topic:${key}`));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  return `${cap(pick(VOCAB.adjectives))} ${pick(VOCAB.nouns)} and ${pick(VOCAB.nouns)}`;
}
