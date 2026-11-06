// SAMPLE DATA: Northwind Outdoor, a fictional outdoor-gear shop on the reserved .example TLD. Not a real business.
//
// The homepage preview card and the public sample audit show a real crawler v2 audit of this site
// (scripts/sample-v2.ts crawls it over HTTPS on loopback and runs the full analysis). It is Standard-sized
// (a few hundred pages, inside the Standard profile's 1,000-URL budget) and mostly well built, with defects at the
// rates a real shop has them. "fixed" is the same site after the team fixed some of them and shipped one new page.
import { deflateSync } from "node:zlib";

export type SampleV2State = "original" | "fixed";

export const SITE_NAME = "Northwind Outdoor";
export const HOST = "www.northwind-outdoor.example";
export const BRAND_WORDS = ["northwind"];

export interface Resp {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

// ---------- deterministic randomness ----------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Picks `n` distinct items from `pool`, the same ones every run for the same seed. */
function pick<T>(pool: readonly T[], n: number, seed: string): T[] {
  const idx = pool.map((_, i) => i).sort((a, b) => hash(`${seed}:${a}`) - hash(`${seed}:${b}`));
  return idx.slice(0, Math.min(n, pool.length)).map((i) => pool[i]);
}
const one = <T,>(pool: readonly T[], seed: string): T => pool[hash(seed) % pool.length];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------- catalogue ----------

interface Category {
  path: string;
  name: string;
  /** Singular noun for product names. */
  noun: string;
  intro: string;
  features: string[];
  uses: string[];
  care: string[];
  specs: (seed: string) => string;
}

const MODELS = ["Alpine", "Ridge", "Summit", "Valley", "Cascade", "Meadow", "Harbor", "Canyon", "Glacier", "Prairie", "Birch", "Cedar", "Fjord", "Granite", "Heather", "Juniper", "Lakeside", "Moraine", "Pinnacle", "Quarry", "Redwood", "Sierra", "Tundra", "Upland", "Willow"];
const VARIANTS = ["Classic", "Light"];

const CATEGORIES: Category[] = [
  {
    path: "/tents/",
    name: "Tents",
    noun: "Tent",
    intro: "Backpacking, family and four-season tents, pitched and slept in by our team before they reach the shop.",
    features: [
      "The inner tent clips to the poles, so the whole shelter goes up in under five minutes even in a stiff breeze.",
      "Two doors and two porches mean nobody climbs over a sleeping partner at three in the morning.",
      "Colour-coded pole sleeves take the guesswork out of pitching in the dark.",
      "A full-length fly reaches close to the ground and keeps rain from blowing under the edges.",
      "Mesh panels high on the inner let condensation escape on cold, still nights.",
      "Aluminium stakes with a Y profile grip in sand and loose gravel where round pins pull out.",
      "Every seam is taped at the factory, and we check a sample from each batch in a rain chamber.",
      "The groundsheet wraps up the sides like a bathtub, so puddles stay outside.",
      "Internal pockets hold a headtorch, glasses and a phone off the floor.",
      "Reflective guy lines are easy to spot when you walk back from the stream after dark.",
      "The poles are pre-bent, which adds headroom without adding weight.",
      "A small vent above each door can be propped open with a stiffened strut.",
      "The fly can be pitched on its own with the footprint for a fast, light shelter.",
      "Pack size is short enough to fit across the bottom of most rucksacks.",
    ],
    uses: [
      "It suits long weekends on waymarked trails and campsites with a little wind.",
      "We recommend it for summer hut-to-hut routes where you want a back-up shelter.",
      "It is a strong choice for canoe trips, where weight matters less than space.",
      "Families use it for festival weekends and campsites with a car close by.",
      "It handles exposed moorland and coastal pitches better than most tents of its weight.",
      "Choose it for spring and autumn trips when nights drop close to freezing.",
    ],
    care: [
      "Dry the tent fully before storing it, and keep it loosely packed in a cool cupboard.",
      "Brush grit off the zips after each trip and they will run smoothly for years.",
      "Wash with plain water and a soft sponge; detergents strip the waterproof coating.",
      "Our repair team can replace a broken pole section, usually within a week.",
    ],
    specs: (s) => `Sleeps ${1 + (hash(s) % 4)}. Packed weight ${(1.2 + (hash(s + "w") % 30) / 10).toFixed(1)} kg. Peak height ${95 + (hash(s + "h") % 40)} cm.`,
  },
  {
    path: "/backpacks/",
    name: "Backpacks",
    noun: "Pack",
    intro: "Daypacks and trekking packs with harnesses you can adjust to your back length, from 20 to 70 litres.",
    features: [
      "The back length adjusts in the shop or at home with a single sliding yoke.",
      "A ventilated mesh back panel keeps a gap between your shirt and the pack.",
      "Hip belt pockets are big enough for a phone, a map and a bar.",
      "The lid converts into a small bum bag for summit walks.",
      "Side compression straps cinch a half-empty pack so it does not sway.",
      "A front stretch pocket swallows a wet waterproof without soaking the main bag.",
      "The bottom compartment keeps a sleeping bag apart from food and stove.",
      "Load lifters pull the weight close to your shoulders on steep ground.",
      "There is a sleeve for a three-litre hydration bladder, with a port on each side.",
      "Two ice axe loops and a pole holder sit on the front panel.",
      "The fabric is a recycled nylon with a coating that sheds light rain.",
      "A built-in rain cover lives in a zipped pocket under the base.",
      "Women's and men's harnesses share the same bag, with different shoulder straps and belts.",
      "Every buckle can be replaced in the field without sewing.",
    ],
    uses: [
      "It is sized for day walks with a full set of layers and lunch.",
      "We pack it for three-day trips with a light tent and stove.",
      "It works well as cabin luggage and still feels right on the trail.",
      "Choose it for winter day walks, when you carry more spare clothing.",
      "Trail runners and fast hikers like it for long days with little kit.",
      "It suits a week of trekking between huts, where you carry no tent.",
    ],
    care: [
      "Empty the pack after each trip and let it dry with every pocket open.",
      "Hand wash with mild soap; never put a pack in a washing machine.",
      "Store it hanging, so the foam in the harness keeps its shape.",
      "We repair torn fabric and broken buckles for the life of the pack.",
    ],
    specs: (s) => `Volume ${20 + 5 * (hash(s) % 11)} litres. Weight ${(0.6 + (hash(s + "w") % 16) / 10).toFixed(1)} kg. Fits back lengths ${40 + (hash(s + "b") % 4)} to ${52 + (hash(s + "b") % 4)} cm.`,
  },
  {
    path: "/sleeping-bags/",
    name: "Sleeping bags",
    noun: "Sleeping Bag",
    intro: "Down and synthetic sleeping bags rated to the European standard, with honest comfort temperatures.",
    features: [
      "The hood draws close with one hand and does not cover your mouth.",
      "A draft collar sits around your shoulders and keeps warm air inside.",
      "The zip runs down one side and has a stiff guard that stops it snagging.",
      "Responsibly sourced down is certified from farm to factory.",
      "Synthetic fill keeps much of its warmth when it gets damp.",
      "The foot box is shaped so your feet can rest naturally.",
      "A small inner pocket keeps a phone battery warm overnight.",
      "Left and right zips let two bags join into a double.",
      "The compression sack shrinks it to the size of a loaf of bread.",
      "Baffles are sewn through only where the bag is meant to be cool.",
      "A storage sack is included, so the fill is not crushed between trips.",
      "The shell fabric resists light drizzle and condensation from the tent wall.",
      "Grab loops inside the hem make it easy to pull up in the night.",
      "Comfort and limit temperatures are printed on the label and on this page.",
    ],
    uses: [
      "It suits summer camping in the lowlands and warm nights in the hills.",
      "We take it on spring and autumn trips where frost is possible.",
      "It is warm enough for winter camping with a good insulated mat.",
      "Choose it for hut trips, where blankets are thin or missing.",
      "It is a light option for cycle touring in warm months.",
      "Families like it for campsite holidays from May to September.",
    ],
    care: [
      "Air the bag for a day after each trip before storing it loose.",
      "Wash down bags with a down cleaner and tumble dry on low with clean balls.",
      "Never store a sleeping bag compressed; the fill loses loft over time.",
      "Our workshop can add down or replace a zip if yours wears out.",
    ],
    specs: (s) => `Comfort ${-5 + (hash(s) % 15)} °C. Weight ${(0.7 + (hash(s + "w") % 14) / 10).toFixed(1)} kg. Fits people up to ${175 + 5 * (hash(s + "l") % 4)} cm.`,
  },
  {
    path: "/clothing/",
    name: "Clothing",
    noun: "Jacket",
    intro: "Waterproof shells, insulated jackets and base layers that are made to be repaired, not replaced.",
    features: [
      "The hood adjusts at the back and sides, so it turns with your head.",
      "Pit zips open wide when you are working hard on a climb.",
      "The hem drops lower at the back to cover a hip belt.",
      "Chest pockets sit above a rucksack strap and harness.",
      "Cuffs close with soft tabs that do not catch on gloves.",
      "The face fabric is recycled and free of persistent chemicals.",
      "Seams are taped with narrow tape for a softer feel.",
      "A two-way front zip lets you vent from the bottom.",
      "The jacket packs into its own pocket with a clip loop.",
      "Underarm panels stretch, so reaching for a hold does not lift the hem.",
      "The collar is lined with a soft brushed fabric where it meets the chin.",
      "A wired peak keeps rain off your glasses.",
      "Insulation is placed where you lose heat and kept thin under the arms.",
      "Every jacket has spare fabric in a pocket for patching.",
    ],
    uses: [
      "It works as a year-round shell for hillwalking in changeable weather.",
      "We wear it for cycling to work and for weekends in the hills.",
      "It suits winter walks as a warm layer under a shell.",
      "Choose it for travel, where one jacket has to do everything.",
      "It is light enough to carry all summer in case the weather turns.",
      "Climbers like the cut, which stays put under a harness.",
    ],
    care: [
      "Wash with a technical cleaner and reproof when water stops beading.",
      "Tumble drying on low restores the water repellent finish.",
      "Close every zip and tab before washing to protect the fabric.",
      "Send it to our repair team if a seam lifts or a zip fails.",
    ],
    specs: (s) => `Weight ${300 + 20 * (hash(s) % 20)} g. Hydrostatic head ${10 + 5 * (hash(s + "h") % 4)},000 mm. Sizes XS to ${one(["XL", "XXL"], s)}.`,
  },
  {
    path: "/footwear/",
    name: "Footwear",
    noun: "Boot",
    intro: "Walking boots, trail shoes and approach shoes, fitted in store or by video call with our boot fitters.",
    features: [
      "The sole has deep lugs that clear mud quickly on wet paths.",
      "A rubber rand protects the toe and sides from rocks.",
      "The waterproof lining is breathable, so feet stay dry from inside too.",
      "Lacing hooks lock at the ankle, so you can tie the top and bottom differently.",
      "The footbed is removable and works with custom insoles.",
      "A heel brake helps on steep, loose descents.",
      "The upper is a single piece of leather with very few seams.",
      "The midsole is firm enough for a heavy pack and soft enough for road sections.",
      "The tongue is gusseted to keep out grit and water.",
      "Resoling is possible, so a good upper can last for many years.",
      "The toe box is wide enough for feet that swell on long days.",
      "Pull loops on the heel and tongue make them quick to put on.",
      "The outsole compound grips on wet rock and slab.",
      "A half size range is stocked for every length.",
    ],
    uses: [
      "It suits day walks on rough paths and mountain trails.",
      "We wear it for multi-day treks with a full pack.",
      "It is a light choice for summer trails and travel.",
      "Choose it for winter walking with flexible crampons.",
      "Scramblers like the precise toe on rocky ridges.",
      "It works for dog walks and muddy fields close to home.",
    ],
    care: [
      "Brush off mud and dry them away from direct heat.",
      "Treat the leather with wax a few times a year.",
      "Remove the footbeds after wet days so the lining dries.",
      "Our cobbler can resole them once the tread wears down.",
    ],
    specs: (s) => `Weight ${500 + 30 * (hash(s) % 20)} g per pair. Drop ${6 + (hash(s + "d") % 8)} mm. Sizes 36 to ${46 + (hash(s + "z") % 3)}.`,
  },
  {
    path: "/cooking/",
    name: "Cooking",
    noun: "Stove",
    intro: "Stoves, pans and mugs for brewing up on the trail, tested side by side for boil time and fuel use.",
    features: [
      "The burner simmers well, so you can cook more than boiling water.",
      "A built-in igniter means no matches in wet weather.",
      "The pot stand folds out wide enough for a family pan.",
      "A windshield clips around the burner and stows inside the pot.",
      "Fuel use is measured in our tests and printed on this page.",
      "The handle locks so the pan does not tip when lifted.",
      "Everything nests inside the largest pot with a gas canister.",
      "The base has a heat exchanger that saves fuel in wind.",
      "A pressure regulator keeps output steady as the canister cools.",
      "The lid has a strainer and a small pouring spout.",
      "Hard anodised aluminium resists scratches from spoons.",
      "Spare parts are sold separately and the burner can be serviced.",
      "The stove weighs less than a chocolate bar.",
      "A mesh bag keeps the set together and dries quickly.",
    ],
    uses: [
      "It suits solo trips, where speed and weight matter most.",
      "We take it on group trips that cook proper meals.",
      "It is reliable in cold weather and at altitude.",
      "Choose it for car camping, where size does not matter.",
      "Cyclists like it because it packs small in a frame bag.",
      "It works for a brew on a day walk as well as long trips.",
    ],
    care: [
      "Let the burner cool before packing it away.",
      "Clean the jet with the supplied tool if the flame turns yellow.",
      "Wash pans with warm water and avoid metal scourers.",
      "Store canisters upright and away from heat.",
    ],
    specs: (s) => `Output ${2 + (hash(s) % 3)}.${hash(s + "o") % 10} kW. Boils one litre in ${3 + (hash(s + "b") % 3)} min ${10 * (hash(s + "t") % 6)} s. Weight ${80 + 10 * (hash(s + "w") % 30)} g.`,
  },
];

const TESTERS = ["Priya, who runs our boot room", "Tom from the repair workshop", "Hannah on the online team", "Marcus, our buyer", "Elin, a mountain leader who works Saturdays", "Joe from the Bristol shop floor", "Aisha, who leads our staff walks", "Callum in the warehouse"];
/** Trip notes from staff, shared by every range: most of a product page's text comes from here. */
const NOTES = [
  "We pitched camp beside a loch just as the midges gave up for the evening.",
  "A ferry delay meant an extra night on the island, and nobody complained.",
  "Rain arrived at lunchtime and stayed until the following afternoon.",
  "The forecast promised sunshine and delivered sleet, which taught us a lot.",
  "Our longest day covered thirty-one kilometres with a heavy climb at the end.",
  "Frost covered everything at dawn, and the stream had a skin of ice.",
  "A family of red deer crossed the path a few metres in front of us.",
  "We shared a bothy with two cyclists who had ridden from Inverness.",
  "Strong gusts on the ridge made every break a short one.",
  "The village shop sold out of bread, so dinner was porridge again.",
  "Clear skies after midnight showed more stars than any of us had seen in years.",
  "We waded a river that was knee deep after two days of rain.",
  "Morning mist burned off by ten, leaving a perfect blue afternoon.",
  "A borrowed map with coffee stains still got us home in poor visibility.",
  "The campsite owner lent us a mallet when the ground turned out to be rock hard.",
  "Sheep woke us at five, which at least meant an early start.",
  "Hail bounced off the slope for ten minutes and then vanished.",
  "Our route followed an old drovers road for most of the second day.",
  "We met a ranger who pointed out the best spring for water.",
  "Heavy dew soaked boots and trousers within an hour of leaving camp.",
  "A puncture on the bike trip cost us an hour and taught us a new trick.",
  "The hut warden served soup that we still talk about months later.",
  "Low cloud hid the summit, so we turned back at the cairn below it.",
  "Snow lingered in the gullies well into June.",
  "We found a sheltered hollow behind a wall when the wind swung north.",
  "The train home was cancelled, so the walk ended with a long pub lunch.",
  "Bog cotton covered the moor for miles in every direction.",
  "An evening swim in the tarn was colder than anyone admitted.",
  "We watched an eagle circle above the corrie for most of an hour.",
  "Dry stone walls guided us across the fell when the path disappeared.",
  "Thunder rolled around the valley at dusk, but the storm passed to the east.",
  "Every stream was running high after a wet week, so we chose bridges carefully.",
  "Sunrise from the col was worth the cold four o'clock alarm.",
  "We cooked breakfast under a tarp while drizzle drifted across the field.",
  "The last mile was on a quiet lane lined with foxgloves.",
  "Gritstone edges gave way to limestone pavement by the afternoon.",
  "A fallen tree blocked the forest track, so we scrambled around it.",
  "Our water filter earned its keep on the dry second day.",
  "We swapped stories with a couple walking from Land's End to John o' Groats.",
  "Autumn colour turned the valley gold and copper by the end of the week.",
  "Seals watched from the rocks as we ate lunch above the cove.",
  "The bus driver waited while we unloaded bikes at the trailhead.",
  "Wild garlic filled the woodland with its smell all morning.",
  "Puffins nested on the cliffs just beyond the lighthouse.",
  "Our guidebook was twenty years old, and the bridge it mentioned had gone.",
  "Night fell quickly in the forest, and headtorches came out early.",
  "Granite slabs stayed grippy even after a short shower.",
  "A farmer pointed out a shortcut through the orchard.",
  "The tide came in faster than expected, so we climbed the stile and waited.",
  "Larch trees glowed yellow against a dark slate sky.",
  "We counted nine waterfalls on the descent into the glen.",
  "A curlew called across the marsh as the light faded.",
  "The youth hostel kitchen was busy with walkers drying socks over the radiator.",
  "Chalk downland made for fast, easy miles above the coast.",
  "Our friend's dog insisted on carrying a stick for twelve kilometres.",
  "Pine martens raided the bins at the forest campsite overnight.",
  "Scree on the final slope slowed everyone to a careful shuffle.",
  "We timed the crossing of the sands with the help of the local guide.",
  "Bluebells carpeted the beech wood below the escarpment.",
  "The canal towpath gave us a flat, quiet route out of the city.",
  "Fog horns sounded from the harbour all through the night.",
  "Blackberries along the lane made the last hour very slow.",
  "Kestrels hovered over the verge as traffic rushed past below.",
  "A volunteer at the visitor centre warned us about the closed footbridge.",
  "Heather was in full bloom, purple from the road to the horizon.",
  "We watched the eclipse from a hilltop with half the village.",
  "An old railway viaduct carried the path high over the river.",
  "Salt spray coated our glasses on the exposed headland.",
  "The pub had a drying room, which felt like luxury after three wet days.",
  "Lichen-covered oaks gave the valley a strange, ancient feel.",
  "Swallows skimmed the meadow in front of the tent every evening.",
  "Peat hags made the plateau slow going without a clear path.",
  "A rainbow hung over the reservoir for the whole of breakfast.",
  "We swapped the planned summit for a lower circuit when gusts reached fifty miles an hour.",
  "Otters played in the river below the bridge at dusk.",
  "The ferryman knew every walker by the end of the week.",
  "Wind turbines turned slowly on the far ridge, the only sound for miles.",
  "Limestone gorges kept us in shade during the hottest afternoon.",
  "A lost glove turned up on a fence post two days later.",
  "Snowdrops lined the churchyard where the walk began.",
];

export interface Product {
  path: string;
  name: string;
  category: Category;
  price: number;
}

/** 50 products per category: 300 in all. */
export const PRODUCTS: Product[] = CATEGORIES.flatMap((c) =>
  MODELS.flatMap((m) => VARIANTS.map((v) => ({ m, v }))).map(({ m, v }) => {
    const name = `${m} ${v} ${c.noun}`;
    return { path: `${c.path}${slug(`${m} ${v}`)}`, name, category: c, price: 39 + (hash(name) % 40) * 10 };
  }),
);

const POST_TOPICS = [
  ["How to choose a tent for wild camping", "tents"],
  ["Layering for winter walks", "clothing"],
  ["Breaking in new walking boots", "footwear"],
  ["What sleeping bag temperature ratings mean", "sleeping"],
  ["Packing a rucksack for a three-day trip", "packs"],
  ["Cooking real food on a small stove", "cooking"],
  ["Our favourite coastal walks this autumn", "routes"],
  ["Repairing a waterproof jacket at home", "repair"],
  ["Camping in the rain without misery", "tents"],
  ["Choosing a sleeping mat", "sleeping"],
  ["Walking poles: worth it or not", "routes"],
  ["Looking after down gear", "repair"],
  ["A beginner guide to hut trips", "routes"],
  ["How we test waterproof fabrics", "clothing"],
  ["Fitting a rucksack properly", "packs"],
  ["Trail shoes or boots for summer", "footwear"],
  ["Planning water on dry routes", "routes"],
  ["Lightweight cooking for long trails", "cooking"],
  ["Pitching a tent in strong wind", "tents"],
  ["Washing and reproofing outdoor clothing", "repair"],
  ["What to pack for a winter day walk", "clothing"],
  ["Choosing socks for long walks", "footwear"],
  ["Keeping warm at night in a tent", "sleeping"],
  ["Navigation basics with map and compass", "routes"],
  ["Our lifetime repair promise explained", "repair"],
  ["Family camping checklist", "tents"],
  ["Carrying a camera on the hill", "packs"],
  ["Breakfast ideas for camping trips", "cooking"],
  ["Walking with dogs in the hills", "routes"],
  ["Buying second-hand outdoor kit", "repair"],
  ["Storing gear over the winter", "repair"],
  ["How to read a weather forecast for the mountains", "routes"],
  ["Choosing a stove for cold weather", "cooking"],
  ["Insulated jackets compared", "clothing"],
  ["A guide to tent footprints", "tents"],
  ["Getting started with backpacking", "packs"],
] as const;

const POST_SENTENCES: Record<string, string[]> = {
  tents: [
    "Pick a pitch that is flat, sheltered and above the lowest ground, where cold air and water collect.",
    "Pitch the tail of the tent into the wind so gusts slide over the top rather than filling the door.",
    "Peg the corners first, then the guy lines, and tension everything again once the fabric cools.",
    "A footprint protects the groundsheet and lets you pitch the fly first in heavy rain.",
    "Two doors are a luxury on a short trip and a necessity on a long one with a partner.",
    "Condensation is normal; leave the vents open and wipe the inner with a small towel in the morning.",
  ],
  clothing: [
    "Think in three layers: one that moves sweat, one that holds warmth and one that blocks wind and rain.",
    "Merino base layers stay fresher on multi-day trips, while synthetics dry faster after a wash.",
    "A light insulated jacket earns its place at every stop, even in summer.",
    "Waterproofs only breathe when the outside is clean, so wash them more often than you think.",
    "Spare gloves weigh almost nothing and make a cold summit bearable.",
    "Fit matters more than features: try a jacket on with the layers you will wear under it.",
  ],
  footwear: [
    "Feet swell during a long day, so try boots on in the afternoon with your walking socks.",
    "A good fit holds the heel firmly and leaves room to wiggle your toes.",
    "Break new boots in on short walks before taking them on a long route.",
    "Trail shoes dry faster than boots and suit well-made summer paths.",
    "Two thin pairs of socks can prevent blisters better than one thick pair.",
    "Resoling extends the life of good leather boots by many years.",
  ],
  sleeping: [
    "The comfort rating is the temperature at which a typical person sleeps without feeling cold.",
    "Your mat matters as much as your bag, because the ground steals heat all night.",
    "A liner adds a few degrees of warmth and keeps the bag clean.",
    "Eat something before bed; your body needs fuel to stay warm overnight.",
    "Store sleeping bags loose and let them breathe between trips.",
    "Wear a dry hat and socks to bed rather than the clothes you walked in.",
  ],
  packs: [
    "Heavy items go close to your back and between your shoulder blades.",
    "Measure your back length before buying, from the bony bump at your neck to the top of your hips.",
    "The hip belt should carry most of the weight, with the shoulder straps keeping the pack close.",
    "Pack in the order you will need things, with waterproofs and lunch near the top.",
    "A liner bag keeps everything dry even when the pack itself gets soaked.",
    "Adjust the load lifters on steep ground and loosen them on the flat.",
  ],
  cooking: [
    "A windshield can halve the fuel you need on an exposed pitch.",
    "Plan simple meals that use one pot and little water for washing up.",
    "Gas canisters lose pressure in the cold, so keep the next one in your sleeping bag.",
    "Bring a long spoon; it reaches the bottom of a meal pouch without sticky fingers.",
    "Never cook inside the inner tent, and keep the porch ventilated.",
    "Boil only the water you need and keep a lid on the pan.",
  ],
  routes: [
    "Check the forecast for the hills, not the nearest town, before you set out.",
    "Tell someone where you are going and when you expect to be back.",
    "Carry a paper map as well as a phone, and know how to use both.",
    "Plan water stops on dry routes and carry a filter for streams.",
    "Start early in summer to avoid the hottest part of the day.",
    "Turn back when the weather changes; the hill will still be there next week.",
  ],
  repair: [
    "Small tears can be patched with repair tape and a little patience.",
    "Clean zips with a soft brush and a drop of zip lubricant.",
    "Our workshop repaired more than four thousand items last year.",
    "Buying second-hand and repairing extends the life of good kit.",
    "Reproof waterproof fabrics once water stops beading on the surface.",
    "Send us anything that needs more than a quick fix, and we will quote before starting.",
  ],
};

export interface Post {
  path: string;
  title: string;
  topic: string;
  /** Days before the crawl the post was published. */
  ageDays: number;
}

export const POSTS: Post[] = POST_TOPICS.map(([title, topic], i) => ({ path: `/journal/${slug(title)}`, title, topic, ageDays: 6 + i * 9 }));

// ---------- defects ----------

/** Original only: a discontinued product that four journal posts still link to (404). */
const DISCONTINUED = "/tents/storm-shelter";
const DISCONTINUED_LINKERS = new Set(POSTS.filter((p) => p.topic === "tents").map((p) => p.path));
/** Original only: twelve clothing pages left with one shared title after a template change. */
const SHARED_TITLE = new Set(PRODUCTS.filter((p) => p.category.path === "/clothing/").slice(0, 12).map((p) => p.path));
/** Original only: eighteen cooking products imported without a meta description. */
const NO_DESCRIPTION = new Set(PRODUCTS.filter((p) => p.category.path === "/cooking/").slice(0, 18).map((p) => p.path));
/** Both states: in the sitemap from an old range, linked from nowhere. */
const ORPHANS = ["/tents/alpine-2022", "/backpacks/ridge-2022", "/footwear/summit-2022"];
/** Fixed only: a new product page, published without a description and with a duplicate H1. */
const NEW_PRODUCT = "/tents/glacier-expedition";

const INFO = ["/about", "/contact", "/delivery", "/returns", "/faq", "/size-guide", "/repairs", "/stores"] as const;
const NAV = [
  ["/", "Home"],
  ...CATEGORIES.map((c) => [c.path, c.name]),
  ["/journal/", "Journal"],
  ["/about", "About"],
  ["/contact", "Contact"],
] as const;

// ---------- rendering ----------

interface PageParts {
  path: string;
  title: string | null;
  description: string | null;
  h1: string;
  extraH1?: string;
  robots?: string;
  ogType?: string;
  jsonld: object[];
  main: string;
  breadcrumb?: [string, string][];
}

function render(origin: string, p: PageParts): string {
  const url = `${origin}${p.path}`;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    p.title === null ? "" : `<title>${esc(p.title)}</title>`,
    p.description === null ? "" : `<meta name="description" content="${esc(p.description)}">`,
    p.robots ? `<meta name="robots" content="${p.robots}">` : "",
    `<link rel="canonical" href="${url}">`,
    '<link rel="icon" href="/favicon.ico">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:type" content="${p.ogType ?? "website"}">`,
    `<meta property="og:title" content="${esc(p.title ?? p.h1)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${origin}/images/share.png">`,
    '<meta name="twitter:card" content="summary_large_image">',
    ...[...p.jsonld, ...(p.breadcrumb ? [breadcrumbLd(origin, p.breadcrumb)] : [])].map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`),
  ].filter(Boolean);
  const nav = NAV.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("");
  const crumbs = p.breadcrumb ? `<nav aria-label="Breadcrumb"><ol>${p.breadcrumb.map(([h, l]) => `<li><a href="${h}">${esc(l)}</a></li>`).join("")}</ol></nav>` : "";
  return `<!doctype html>
<html lang="en">
<head>
${head.join("\n")}
</head>
<body>
<header><a href="/"><img src="/images/logo.png" alt="${SITE_NAME}" width="160" height="40"></a><nav aria-label="Main"><ul>${nav}</ul></nav></header>
<main>
${crumbs}
<h1>${esc(p.h1)}</h1>
${p.extraH1 ? `<h1>${esc(p.extraH1)}</h1>` : ""}
${p.main}
</main>
<footer><p>${SITE_NAME}, 14 Quay Street, Bristol BS1 4DB. Telephone +44 117 496 0123.</p><ul>${INFO.map((h) => `<li><a href="${h}">${infoTitle(h)}</a></li>`).join("")}</ul><p>Sample site: a fictional shop used by the Site Sentry demo.</p></footer>
</body>
</html>`;
}

function breadcrumbLd(origin: string, items: [string, string][]) {
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([h, l], i) => ({ "@type": "ListItem", position: i + 1, name: l, item: `${origin}${h}` })) };
}

function infoTitle(path: string): string {
  return { "/about": "About us", "/contact": "Contact", "/delivery": "Delivery", "/returns": "Returns", "/faq": "Questions", "/size-guide": "Size guide", "/repairs": "Repairs", "/stores": "Our stores" }[path] ?? path;
}

const para = (sentences: string[]) => `<p>${sentences.join(" ")}</p>`;

function productPage(origin: string, prod: Product, state: SampleV2State): PageParts {
  const c = prod.category;
  const s = prod.path;
  // Each product links to the next three in its category, so every product has three inbound links besides the list.
  const range = PRODUCTS.filter((x) => x.category === c);
  const at = range.findIndex((x) => x.path === s);
  const related = [1, 2, 3].map((k) => range[(at + k) % range.length]);
  const sharedTitle = state === "original" && SHARED_TITLE.has(s);
  const noDescription = state === "original" && NO_DESCRIPTION.has(s);
  const footwear = c.path === "/footwear/";
  const offers = { "@type": "Offer", price: prod.price.toFixed(2), priceCurrency: "GBP", availability: "https://schema.org/InStock", url: `${origin}${s}` };
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: prod.name,
    image: `${origin}/images/products/${s.split("/").pop()}.png`,
    description: `${prod.name} from ${SITE_NAME}.`,
    sku: `NW-${hash(s) % 100000}`,
    brand: { "@type": "Brand", name: SITE_NAME },
    // The footwear template never got its price feed: no offers (SD-009), on every footwear page.
    ...(footwear ? {} : { offers }),
  };
  const file = `/images/products/${s.split("/").pop()}.png`;
  // The backpacks template dropped the image dimensions in a redesign (IMG-007), in both states.
  const img = `<img src="${file}" srcset="${file} 800w" sizes="(max-width: 800px) 100vw, 800px" alt="${esc(prod.name)}"${c.path === "/backpacks/" ? "" : ' width="800" height="600"'}>`;
  return {
    path: s,
    title: sharedTitle ? `Merino Base Layer | ${SITE_NAME}` : `${prod.name} | ${SITE_NAME}`,
    description: noDescription ? null : `${prod.name}, £${prod.price}. Tested by our staff, with free delivery over £50 and 60-day returns. Order today.`,
    h1: prod.name,
    ogType: "product",
    jsonld: [productLd],
    breadcrumb: [["/", "Home"], [c.path, c.name], [s, prod.name]],
    main: [
      img,
      `<p class="price">£${prod.price}.00</p>`,
      para([one(["Meet the", "This is the", "Say hello to the", "Introducing the"], s + "i") + ` ${prod.name}.`, c.specs(s)]),
      "<h2>Features</h2>",
      para(pick(c.features, 3, s + "f")),
      "<h2>Where it shines</h2>",
      para(pick(c.uses, 2, s + "u")),
      "<h2>Trip notes</h2>",
      para(pick(NOTES, 8, s + "n")),
      "<h2>Care and repair</h2>",
      para(pick(c.care, 2, s + "c")),
      `<h2>You might also like</h2><ul>${related.map((r) => `<li><a href="${r.path}">${esc(r.name)}</a></li>`).join("")}</ul>`,
    ].join("\n"),
  };
}

function categoryPage(origin: string, c: Category, state: SampleV2State): PageParts {
  const items = PRODUCTS.filter((p) => p.category === c);
  const extra = state === "fixed" && c.path === "/tents/" ? [{ path: NEW_PRODUCT, name: "Glacier Expedition Tent" }] : [];
  return {
    path: c.path,
    title: `${c.name} | ${SITE_NAME}`,
    description: `Compare ${items.length} ${c.name.toLowerCase()} tested by our staff. Free delivery over £50 and 60-day returns. Shop the range.`,
    h1: c.name,
    // An agency staging setting copied to production on the sleeping bags category (IDX-008), original only.
    robots: state === "original" && c.path === "/sleeping-bags/" ? "noindex, follow" : undefined,
    jsonld: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: c.name, url: `${origin}${c.path}` }],
    breadcrumb: [["/", "Home"], [c.path, c.name]],
    main: [
      para([c.intro, `Every ${c.noun.toLowerCase()} here has been used on real trips by our staff, and our repair team keeps spare parts for each one.`]),
      "<h2>How to choose</h2>",
      para([...pick(c.uses, 4, c.path + "u"), ...pick(c.features, 4, c.path + "f")]),
      "<h2>Looking after it</h2>",
      para(pick(c.care, 3, c.path + "c")),
      `<ul>${[...items, ...extra].map((p) => `<li><a href="${p.path}">${esc(p.name)}</a></li>`).join("")}</ul>`,
    ].join("\n"),
  };
}

function postPage(origin: string, post: Post, state: SampleV2State, crawlDate: Date): PageParts {
  const date = new Date(crawlDate.getTime() - post.ageDays * 86_400_000).toISOString().slice(0, 10);
  const own = POST_SENTENCES[post.topic];
  const others = Object.entries(POST_SENTENCES).filter(([k]) => k !== post.topic).flatMap(([, v]) => v);
  const shop = pick(PRODUCTS, 2, `${post.path}:shop`);
  const next = POSTS[(POSTS.indexOf(post) + 1) % POSTS.length];
  const brokenLink = state === "original" && DISCONTINUED_LINKERS.has(post.path) ? ` The <a href="${DISCONTINUED}">Storm Shelter</a> is still a favourite with our team.` : "";
  return {
    path: post.path,
    title: `${post.title} | ${SITE_NAME} Journal`,
    description: `${post.title}: practical advice from the ${SITE_NAME} team, tested on real trips. Read the guide and plan your next walk.`,
    h1: post.title,
    ogType: "article",
    jsonld: [{ "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title, datePublished: date, author: { "@type": "Organization", name: SITE_NAME }, image: `${origin}/images/journal/${post.path.split("/").pop()}.png` }],
    breadcrumb: [["/", "Home"], ["/journal/", "Journal"], [post.path, post.title]],
    main: [
      `<p><time datetime="${date}">${date}</time></p>`,
      // The journal template's photo has no alt attribute (IMG-001), in both states.
      `<img src="/images/journal/${post.path.split("/").pop()}.png" srcset="/images/journal/${post.path.split("/").pop()}.png 1200w" sizes="(max-width: 1200px) 100vw, 1200px" width="1200" height="800">`,
      para([`${one(["This guide comes from", "We wrote this after", "These notes grew out of"], post.path + "i")} ${one(["a season of staff trips", "hundreds of questions in the shop", "a long winter in the repair workshop", "a weekend of testing on Dartmoor"], post.path + "j")}.`, ...pick(own, 3, post.path + "a")]),
      "<h2>What we learned</h2>",
      para([...pick(own, 3, post.path + "b"), ...pick(others, 5, post.path + "o")]),
      "<h2>Before you go</h2>",
      para([`${one(TESTERS, post.path + "t")} adds one tip: ${one(POST_SENTENCES.routes, post.path + "r").replace(/^./, (x) => x.toLowerCase())}`, ...pick(others, 2, post.path + "q")]),
      "<h2>Kit we used</h2>",
      `<p>On this trip we used the <a href="${shop[0].path}">${esc(shop[0].name)}</a> and the <a href="${shop[1].path}">${esc(shop[1].name)}</a>.${brokenLink}</p>`,
      `<p>Read next: <a href="${next.path}">${esc(next.title)}</a>.</p>`,
    ].join("\n"),
  };
}

function journalIndex(origin: string): PageParts {
  return {
    path: "/journal/",
    title: `Journal: guides and trip reports | ${SITE_NAME}`,
    description: `Guides, trip reports and repair advice from the ${SITE_NAME} team. Find your next route and learn how to look after your kit.`,
    h1: "Journal",
    jsonld: [{ "@context": "https://schema.org", "@type": "Blog", name: `${SITE_NAME} Journal`, url: `${origin}/journal/` }],
    breadcrumb: [["/", "Home"], ["/journal/", "Journal"]],
    main: [
      para([
        "Practical guides written by the people who staff our shops and repair workshop, and trip reports from the places we walk.",
        "New posts appear every week or two, usually after a staff trip or a busy season in the workshop.",
        "If there is something you would like us to write about, tell us in the shop or by email and we will add it to the list.",
        "Every guide is checked by at least two members of the team who have used the kit or walked the route themselves.",
      ]),
      `<ul>${POSTS.map((p) => `<li><a href="${p.path}">${esc(p.title)}</a></li>`).join("")}</ul>`,
    ].join("\n"),
  };
}

const INFO_TEXT: Record<(typeof INFO)[number], { title: string; description: string; h1: string; body: string[] }> = {
  "/about": {
    title: "About Northwind Outdoor",
    description: "An independent outdoor shop in Bristol since 1998, with a repair workshop and a lifetime repair promise. Visit us or shop online.",
    h1: "About us",
    body: [
      "We opened our first shop on Quay Street in 1998, selling tents and boots to walkers heading for the Brecon Beacons and Dartmoor.",
      "Today the team is thirty people, and most of us still spend our weekends in the hills, testing what we sell.",
      "Our repair workshop fixes zips, seams, poles and soles, and we would always rather mend something than replace it.",
      "Everything we stock is chosen because it lasts, and because the maker supplies spare parts for years after it is sold.",
    ],
  },
  "/contact": {
    title: `Contact us | ${SITE_NAME}`,
    description: "Call, email or visit our Bristol shop. We answer most questions within a working day, and our boot fitters can help by video.",
    h1: "Contact us",
    body: [
      "Call us on +44 117 496 0123, Monday to Saturday from 9am to 6pm, or email help@northwind-outdoor.example.",
      "Our shop is at 14 Quay Street, Bristol BS1 4DB, a short walk from Temple Meads station.",
      "Boot fitting appointments by video call can be booked on any weekday afternoon.",
      "For repairs, include your order number and a photo of the damage, and we will reply with a quote.",
    ],
  },
  "/delivery": {
    title: `Delivery | ${SITE_NAME}`,
    description: "Free standard delivery on orders over £50, next-day delivery for £6, and click and collect from our Bristol shop. See the details.",
    h1: "Delivery",
    body: [
      "Standard delivery takes two to four working days and is free on orders over fifty pounds.",
      "Next-day delivery costs six pounds when you order before two in the afternoon.",
      "Click and collect from our Bristol shop is free, and orders are usually ready the same day.",
      "We ship to most European countries; costs are shown at checkout before you pay.",
    ],
  },
  "/returns": {
    title: `Returns | ${SITE_NAME}`,
    description: "Return unused items within 60 days for a full refund. Free returns by post or in store, with refunds in five working days. Start a return.",
    h1: "Returns",
    body: [
      "You can return unused items within sixty days of delivery for a full refund.",
      "Returns are free by post using the label in your parcel, or in person at our shop.",
      "Refunds reach your account within five working days of the parcel arriving.",
      "Boots that have been worn outdoors can be exchanged if they do not fit after a fair trial.",
    ],
  },
  "/faq": {
    title: `Questions and answers | ${SITE_NAME}`,
    description: "Answers to the questions we hear most, from sizing and delivery to repairs and gift cards. Can not find yours? Contact our team.",
    h1: "Questions and answers",
    body: [
      "<h2>Do you repair items bought elsewhere?</h2><p>Yes. Our workshop repairs most outdoor gear, whoever made it, and we quote before starting.</p>",
      "<h2>How do I find my size?</h2><p>Use the size guide for each range, or book a free video fitting with our team.</p>",
      "<h2>Do you sell gift cards?</h2><p>Gift cards from ten to five hundred pounds can be used online and in our shop.</p>",
      "<h2>Can I rent a tent?</h2><p>We rent tents and sleeping bags from our shop for weekend trips, with a deposit.</p>",
    ],
  },
  "/size-guide": {
    title: `Size guide | ${SITE_NAME}`,
    description: "Measure your chest, waist, back length and feet, and find the right size in every range we sell. Book a free video fitting.",
    h1: "Size guide",
    body: [
      "Measure your chest around the fullest part, keeping the tape level under your arms.",
      "For rucksacks, measure your back from the bony bump at the base of your neck to the top of your hip bones.",
      "Feet are measured standing, in the afternoon, wearing the socks you walk in.",
      "If you fall between two sizes, choose the larger for jackets and the smaller for base layers.",
    ],
  },
  "/repairs": {
    title: `Repairs | ${SITE_NAME}`,
    description: "Our Bristol workshop repairs zips, seams, poles and soles, with a lifetime repair promise on everything we sell. Book a repair.",
    h1: "Repairs",
    body: [
      "Everything we sell is covered by our lifetime repair promise for faults from normal use.",
      "We repair zips, seams, tent poles, sleeping bag baffles and boot soles in our workshop.",
      "Most repairs take one to two weeks, and we return the item by post or hold it for collection.",
      "Last year the workshop repaired more than four thousand items that would otherwise have been thrown away.",
    ],
  },
  "/stores": {
    title: `Our stores | ${SITE_NAME}`,
    description: "Visit our Bristol shop for boot fitting, repairs and expert advice, open Monday to Saturday from 9am to 6pm. Plan your visit.",
    h1: "Our stores",
    body: [
      "Our shop is at 14 Quay Street, Bristol BS1 4DB, open Monday to Saturday from 9am to 6pm and Sunday from 10am to 4pm.",
      "Boot fitting is free and takes about forty minutes; book ahead on Saturdays.",
      "There is cycle parking outside and a public car park two minutes away on Prince Street.",
      "The repair counter at the back of the shop takes drop-offs during opening hours.",
    ],
  },
};

const SHOP_FACTS = [
  "Our team answers the phone themselves, and most of them have worked here for more than five years.",
  "We have been on Quay Street since 1998 and moved into the old chandlery next door in 2011.",
  "Orders placed before two in the afternoon leave our Bristol warehouse the same day.",
  "Every item we sell is covered by our lifetime repair promise for faults from normal use.",
  "We give one per cent of our turnover to footpath repair and mountain rescue teams.",
  "Our packaging is recycled card and paper tape, with no plastic fillers.",
  "Gift cards can be used online and in the shop, and they never expire.",
  "Students and members of mountain rescue teams get ten per cent off with a valid card.",
  "Staff walks leave from the shop on the first Sunday of every month, and anyone can join.",
  "Our repair workshop shares a building with the shop, so you can talk to the person fixing your kit.",
  "We publish the results of our fabric and stove tests, including the products that failed them.",
  "Customer reviews on our site are never edited, and we reply to every one with a problem.",
  "Rental tents and sleeping bags are cleaned and checked by the workshop between every hire.",
  "We offer free advice evenings in winter on navigation, layering and camping in cold weather.",
];

function infoPage(origin: string, path: (typeof INFO)[number]): PageParts {
  const t = INFO_TEXT[path];
  const html = [t.body.every((b) => b.startsWith("<")) ? t.body.join("\n") : para(t.body), "<h2>Good to know</h2>", para(pick(SHOP_FACTS, 9, path))].join("\n");
  return {
    path,
    title: t.title,
    description: t.description,
    h1: t.h1,
    jsonld: path === "/stores" || path === "/contact" ? [{ "@context": "https://schema.org", "@type": "Store", name: SITE_NAME, url: `${origin}/`, telephone: "+44 117 496 0123", address: { "@type": "PostalAddress", streetAddress: "14 Quay Street", addressLocality: "Bristol", postalCode: "BS1 4DB", addressCountry: "GB" }, openingHours: "Mo-Sa 09:00-18:00" }] : [],
    breadcrumb: [["/", "Home"], [path, t.h1]],
    main: html,
  };
}

function homePage(origin: string, state: SampleV2State): PageParts {
  const featured = pick(PRODUCTS, 6, "home");
  return {
    path: "/",
    title: `${SITE_NAME} | Tents, Backpacks and Trail Gear`,
    description: "Tents, backpacks, boots and clothing tested on real trips by our team, with free delivery over £50 and a lifetime repair promise. Shop now.",
    h1: "Gear that goes the distance",
    jsonld: [{ "@context": "https://schema.org", "@type": "Organization", name: SITE_NAME, url: `${origin}/`, logo: `${origin}/images/logo.png`, telephone: "+44 117 496 0123", email: "help@northwind-outdoor.example", description: "Independent outdoor shop in Bristol with a repair workshop.", address: { "@type": "PostalAddress", streetAddress: "14 Quay Street", addressLocality: "Bristol", postalCode: "BS1 4DB", addressCountry: "GB" } }],
    main: [
      para([
        "We are an independent outdoor shop in Bristol, choosing kit that lasts and repairing it when it does not.",
        "Everything here has been used by our staff on real trips, from Dartmoor bogs to Alpine huts.",
      ]),
      "<h2>Why shop with us</h2>",
      para(pick(SHOP_FACTS, 7, "home")),
      `<h2>Shop by category</h2><ul>${CATEGORIES.map((c) => `<li><a href="${c.path}">${c.name}</a></li>`).join("")}</ul>`,
      `<h2>Staff favourites</h2><ul>${featured.map((p) => `<li><a href="${p.path}">${esc(p.name)}</a></li>`).join("")}</ul>`,
      `<h2>From the journal</h2><ul>${POSTS.slice(0, 4).map((p) => `<li><a href="${p.path}">${esc(p.title)}</a></li>`).join("")}</ul>`,
      // The 2023 catalogue link still goes through three old redirects (IDX-003, LNK-002); fixed by linking the target.
      `<p>Looking for last year's range? <a href="${state === "original" ? "/catalogue-2023" : "/tents/"}">Browse the archive</a>.</p>`,
    ].join("\n"),
  };
}

function newProductPage(origin: string): PageParts {
  const c = CATEGORIES[0];
  const name = "Glacier Expedition Tent";
  return {
    path: NEW_PRODUCT,
    title: `${name} | ${SITE_NAME}`,
    // Published in a hurry: no description (META-008) and the old H1 left in the template (CNT-002).
    description: null,
    h1: name,
    extraH1: "New for winter",
    ogType: "product",
    jsonld: [{ "@context": "https://schema.org", "@type": "Product", name, image: `${origin}/images/products/glacier-expedition.png`, sku: "NW-90001", brand: { "@type": "Brand", name: SITE_NAME }, offers: { "@type": "Offer", price: "649.00", priceCurrency: "GBP", availability: "https://schema.org/PreOrder" } }],
    breadcrumb: [["/", "Home"], [c.path, c.name], [NEW_PRODUCT, name]],
    main: [
      `<img src="/images/products/glacier-expedition.png" alt="${name}" width="800" height="600">`,
      "<p class=\"price\">£649.00</p>",
      para(["A four-season dome for winter camping and expeditions, with snow valances and a vestibule large enough to cook in.", c.specs(NEW_PRODUCT)]),
      "<h2>Features</h2>",
      para(pick(c.features, 6, NEW_PRODUCT)),
      "<h2>Care and repair</h2>",
      para(pick(c.care, 2, NEW_PRODUCT)),
    ].join("\n"),
  };
}

function orphanPage(path: string): PageParts {
  const name = `${path.split("/")[2].split("-")[0].replace(/^./, (x) => x.toUpperCase())} 2022 edition`;
  return {
    path,
    title: `${name} | ${SITE_NAME}`,
    description: `${name}: no longer made, but spare parts and repairs are still available from our workshop. Book a service today.`,
    h1: name,
    jsonld: [],
    main: para([
      "This edition is no longer made, but our repair workshop still keeps spare parts and can service it.",
      "Its replacement keeps the same shape and improves the fabric, zips and pack size.",
      "If you own one, register it with us and we will tell you when parts are about to run out.",
      "Customers who bought it in 2022 can trade it in against a new model in our Bristol shop.",
      "We keep this page so that owners can find care instructions and manuals.",
    ]),
  };
}

// ---------- the site ----------

export interface SampleSite {
  /** Every page path served with status 200, in a fixed order. */
  pages: string[];
  respond(path: string, method?: string): Resp;
}

/** A minimal valid greyscale PNG of the given size. */
export function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(h * (w + 1)))), chunk("IEND", Buffer.alloc(0))]);
}
const FAVICON = Buffer.from("AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAAA=", "base64");

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "default-src 'self'; img-src 'self' data:",
};

/** The site at `origin` (scheme, host and port the crawler uses) in `state`, as the crawl on `crawlDate` sees it. */
export function sampleSite(origin: string, state: SampleV2State, crawlDate: Date): SampleSite {
  const table = new Map<string, () => PageParts>();
  table.set("/", () => homePage(origin, state));
  for (const c of CATEGORIES) table.set(c.path, () => categoryPage(origin, c, state));
  for (const p of PRODUCTS) table.set(p.path, () => productPage(origin, p, state));
  table.set("/journal/", () => journalIndex(origin));
  for (const p of POSTS) table.set(p.path, () => postPage(origin, p, state, crawlDate));
  for (const i of INFO) table.set(i, () => infoPage(origin, i));
  for (const o of ORPHANS) table.set(o, () => orphanPage(o));
  if (state === "fixed") table.set(NEW_PRODUCT, () => newProductPage(origin));
  const pages = [...table.keys()];

  const redirects: Record<string, string> = { "/catalogue-2023": "/catalogue", "/catalogue": "/shop/archive/", "/shop/archive/": "/tents/" };
  const lastmod = (path: string) => new Date(Date.UTC(2026, 6, 1) + (hash(path) % 90) * 86_400_000).toISOString().slice(0, 10);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${origin}${p}</loc><lastmod>${lastmod(p)}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  const html = (body: string, status = 200): Resp => ({ status, type: "text/html; charset=utf-8", body, headers: SECURITY_HEADERS });
  const notFound = () => html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found | ${SITE_NAME}</title></head><body><h1>Page not found</h1><p>Sorry, that page does not exist.</p></body></html>`, 404);
  const asset = (body: Buffer, type: string): Resp => ({ status: 200, type, body, headers: { "cache-control": "public, max-age=31536000, immutable", ...SECURITY_HEADERS } });

  return {
    pages,
    respond(rawPath) {
      const path = new URL(rawPath, "https://x").pathname;
      if (path === "/robots.txt") return { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /checkout/\nDisallow: /account/\n\nSitemap: ${origin}/sitemap.xml\n`, headers: SECURITY_HEADERS };
      if (path === "/sitemap.xml") return { status: 200, type: "application/xml", body: sitemap, headers: SECURITY_HEADERS };
      if (path === "/llms.txt")
        return { status: 200, type: "text/plain; charset=utf-8", body: `# ${SITE_NAME}\n\n> Independent outdoor shop in Bristol: tents, backpacks, sleeping bags, clothing, footwear and stoves, with a repair workshop.\n\n## Shop\n\n${CATEGORIES.map((c) => `- [${c.name}](${origin}${c.path})`).join("\n")}\n\n## Help\n\n- [Delivery](${origin}/delivery)\n- [Returns](${origin}/returns)\n- [Repairs](${origin}/repairs)\n`, headers: SECURITY_HEADERS };
      if (path === "/favicon.ico") return asset(FAVICON, "image/x-icon");
      if (path === "/images/share.png") return asset(png(1200, 630), "image/png");
      if (path === "/images/logo.png") return asset(png(160, 40), "image/png");
      if (path.startsWith("/images/journal/")) return asset(png(1200, 800), "image/png");
      if (path.startsWith("/images/products/")) return asset(png(800, 600), "image/png");
      if (redirects[path]) return { status: 301, type: "text/html", body: "", headers: { location: redirects[path], ...SECURITY_HEADERS } };
      const page = table.get(path);
      if (!page) return notFound();
      return html(render(origin, page()));
    },
  };
}
