import { matchesAny } from "./matching";

const LOCATION_SYNONYMS: Record<string, string[]> = {
  americas: [
    "usa",
    "us",
    "united states",
    "north america",
    "south america",
    "latin america",
    "latam",
    "canada",
    "brazil",
    "mexico",
    "argentina",
    "colombia",
    "chile",
    "est",
    "edt",
    "cst",
    "cdt",
    "mst",
    "pst",
    "pdt",
    "gmt-5",
    "gmt-8",
    "utc-5",
    "utc-8",
    "new york",
    "california",
    "texas",
    "nyc",
    "sf",
    "san francisco",
    "seattle",
    "boston",
    "chicago",
    "austin",
    "denver",
    "los angeles",
    "miami",
    "toronto",
    "vancouver",
    "montreal",
  ],
  europe: [
    "eu",
    "emea",
    "cet",
    "cest",
    "eet",
    "eest",
    "gmt+1",
    "gmt+2",
    "utc+1",
    "utc+2",
    "germany",
    "netherlands",
    "france",
    "spain",
    "portugal",
    "poland",
    "ireland",
    "sweden",
    "denmark",
    "norway",
    "finland",
    "austria",
    "switzerland",
    "czech",
    "romania",
    "italy",
    "belgium",
    "european union",
    "european",
    "berlin",
    "amsterdam",
    "paris",
    "barcelona",
    "madrid",
    "dublin",
    "stockholm",
    "copenhagen",
    "oslo",
    "helsinki",
    "vienna",
    "zurich",
    "prague",
    "warsaw",
    "lisbon",
    "milan",
    "rome",
    "brussels",
    "budapest",
    "bucharest",
    "ukraine",
    "kyiv",
  ],
  usa: [
    "us",
    "united states",
    "north america",
    "americas",
    "america",
    "est",
    "edt",
    "cst",
    "cdt",
    "mst",
    "pst",
    "pdt",
    "gmt-5",
    "gmt-8",
    "utc-5",
    "utc-8",
    "new york",
    "california",
    "texas",
    "nyc",
    "sf",
    "san francisco",
    "seattle",
    "boston",
    "chicago",
    "austin",
    "denver",
    "los angeles",
    "miami",
  ],
  uk: [
    "united kingdom",
    "great britain",
    "england",
    "gmt",
    "bst",
    "london",
    "manchester",
    "edinburgh",
    "scotland",
    "wales",
  ],
  canada: ["toronto", "vancouver", "montreal", "ottawa"],
  asia: [
    "apac",
    "ist",
    "jst",
    "kst",
    "sgt",
    "gmt+5",
    "gmt+8",
    "gmt+9",
    "utc+5",
    "utc+8",
    "utc+9",
    "india",
    "singapore",
    "japan",
    "korea",
    "china",
    "vietnam",
    "philippines",
    "indonesia",
    "thailand",
    "hong kong",
    "taiwan",
    "southeast asia",
  ],
};

export function expandLocations(locations: string[]): string[] {
  // "Anywhere" = no location restriction, return empty to skip filtering
  if (locations.some((l) => /^anywhere$/i.test(l))) return [];

  const expanded = new Set(locations);
  for (const loc of locations) {
    // "Europe (UTC-1…+3)" → "europe"
    const base = loc.replace(/\s*\(.*\)$/, "").toLowerCase();
    const synonyms = LOCATION_SYNONYMS[base] ?? LOCATION_SYNONYMS[loc.toLowerCase()];
    if (synonyms) for (const s of synonyms) expanded.add(s);
  }
  return [...expanded];
}

const REMOTE_QUALIFIER_RE = /remote\s*[(\-–,]\s*(.+?)\s*\)?$|remote\s+(?:only|based\s+in)\s+(.+)/i;
const WORLDWIDE_RE = /\bworldwide\b|\banywhere\b/;
const REMOTE_RE = /\bremote\b/;

export function passesLocationCheck(location: string, expandedLocations: string[]): boolean {
  const loc = location.toLowerCase();
  if (WORLDWIDE_RE.test(loc)) return true;

  if (REMOTE_RE.test(loc)) {
    const m = REMOTE_QUALIFIER_RE.exec(loc);
    const qualifier = (m?.[1] ?? m?.[2] ?? "").trim();
    if (!qualifier) return true;
    const parts = qualifier
      .split(/[/&,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.some((p) => matchesAny(p, expandedLocations));
  }

  return matchesAny(location, expandedLocations);
}
