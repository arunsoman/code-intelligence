// F04 WP-01: package identity as a Package URL (purl). The purl carries ecosystem, namespace, name and version;
// qualifiers carry `repository_url` for non-default registries — which is also how a private package is recognised.
// Pure functions: build, parse, and the ecosystem name normalisations advisory matching relies on.
export type PurlType = "npm" | "cargo" | "golang" | "pypi" | "maven";

export interface PurlParts {
  type: PurlType;
  namespace?: string;
  name: string;
  version?: string;
  qualifiers?: Record<string, string>;
}

/** Ecosystem name normalisation: npm scopes are lower-cased, PyPI follows PEP 503, Maven coordinates stay as-is. */
export function normalizePackageName(type: PurlType, name: string): string {
  if (type === "npm") return name.trim().toLowerCase();
  if (type === "pypi") return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
  return name.trim();
}

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function buildPurl(parts: PurlParts): string {
  if (!parts.name) throw new Error("purl requires a name");
  const ns = parts.namespace ? `${enc(parts.namespace)}/` : "";
  const ver = parts.version ? `@${enc(parts.version)}` : "";
  const qs = parts.qualifiers && Object.keys(parts.qualifiers).length
    ? "?" + Object.entries(parts.qualifiers).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")
    : "";
  return `pkg:${parts.type}/${ns}${enc(parts.name)}${ver}${qs}`;
}

export function parsePurl(purl: string): PurlParts {
  const m = /^pkg:([a-z][a-z0-9.+-]*)\/([^?]+)(?:\?(.*))?$/i.exec(purl.trim());
  if (!m) throw new Error(`not a purl: ${purl.slice(0, 80)}`);
  const type = m[1].toLowerCase();
  if (!["npm", "cargo", "golang", "pypi", "maven"].includes(type)) throw new Error(`unsupported purl type: ${type}`);
  const rest = m[2];
  const qIdx = rest.lastIndexOf("@");
  const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const version = qIdx >= 0 ? dec(rest.slice(qIdx + 1)) : undefined;
  const segments = path.split("/").map(dec).filter(Boolean);
  if (!segments.length) throw new Error(`purl has no name: ${purl.slice(0, 80)}`);
  const name = segments.pop()!;
  const namespace = segments.length ? segments.join("/") : undefined;
  const qualifiers: Record<string, string> = {};
  if (m[3]) for (const kv of m[3].split("&")) { const i = kv.indexOf("="); if (i > 0) qualifiers[dec(kv.slice(0, i))] = dec(kv.slice(i + 1)); }
  return { type: type as PurlType, namespace, name, version, qualifiers: Object.keys(qualifiers).length ? qualifiers : undefined };
}
