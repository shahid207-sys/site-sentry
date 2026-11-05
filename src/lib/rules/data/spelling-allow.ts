// Words CNT-023 treats as spelled correctly although Hunspell's en_US dictionary lacks them: web and commerce terms,
// platforms named in menus, and the place names of the regions SiteSentry's clients work in. A project adds its own
// through the crawl setting spellingAllow; brand names come from the brand setting and the page's own signals.
export const BUILTIN_ALLOW: readonly string[] = [
  // web, commerce and trade
  "ecommerce", "checkout", "wishlist", "webinar", "webinars", "homepage", "dropshipping", "signage", "infographic", "infographics",
  "prototyping", "filament", "filaments", "resin", "resins", "keychain", "keychains", "lithophane", "lithophanes", "cosplay", "figurine",
  "figurines", "miniatures", "diorama", "dioramas", "printable", "printables", "customizable", "customisable", "personalised", "personalized",
  "faqs", "blog", "blogs", "vlog", "login", "signup", "unboxing", "skincare", "haircare", "eyewear", "activewear", "sportswear", "workwear",
  "upcycled", "eco", "ebook", "ebooks", "app", "apps", "online", "offline", "inbox", "username", "chatbot", "fintech", "proptech", "saas",
  "scalable", "armless", "normals", "rebrand", "rebranding", "onboarding", "upsell", "geotag",
  // platforms
  "pinterest", "instagram", "tiktok", "youtube", "linkedin", "whatsapp", "facebook", "snapchat", "xbox", "playstation", "nintendo",
  "shopify", "woocommerce", "wordpress", "etsy", "paypal", "tabby", "tamara",
  // regions: UAE, GCC and nearby
  "dubai", "sharjah", "ajman", "fujairah", "ras", "khaimah", "umm", "quwain", "abu", "dhabi", "jebel", "deira", "karama", "jumeirah",
  "marina", "alain", "khalifa", "zayed", "mussafah", "riyadh", "jeddah", "dammam", "makkah", "mecca", "madinah", "medina", "doha",
  "qatar", "muscat", "oman", "bahrain", "manama", "kuwait", "amman", "beirut", "cairo", "emirati", "emirates", "saudi", "gcc", "burj",
  "arabic", "arabian", "levant",
];
