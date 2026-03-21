import { matchesAny } from "./matching";

const LOCATION_SYNONYMS: Record<string, string[]> = {
  europe: [
    "eu",
    "emea",
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
    "america",
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
    "london",
    "manchester",
    "edinburgh",
    "scotland",
    "wales",
  ],
  canada: ["toronto", "vancouver", "montreal", "ottawa"],
  asia: [
    "apac",
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

/** Expand user locations with known synonyms (e.g. "Europe" -> "EU", "Germany", "France",  */
export function expandLocations(locations: string[]): string[] {
  const expanded = new Set(locations);
  for (const loc of locations) {
    const synonyms = LOCATION_SYNONYMS[loc.toLowerCase()];
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
