import type { ViewSpec } from "../../schema/src/index.ts";
import { intentById } from "../../schema/src/intents.ts";
import type { ReferentRecord } from "../../schema/src/intents.ts";

export function resolveReferent(
  text: string,
  ledger: ReferentRecord[],
  currentView?: ViewSpec | null,
  selection?: string[]
): ReferentRecord | "ambiguous" | null {
  const anaphoricMarkers = /\b(it|its|it's|that|this|those|them|the (latter|former|same)|the above|the previous)\b/i;
  if (!anaphoricMarkers.test(text)) return null;

  if (ledger.length === 0) return null;

  // Tier 1: Selection chips
  const selectionMatches = ledger.filter(r => selection?.includes(r.entityId));
  if (selectionMatches.length === 1) return selectionMatches[0];
  if (selectionMatches.length > 1) return "ambiguous";

  // Tier 2: Contextual focus (must match revision)
  const currentRevision = currentView?.revision;
  const focusMatch = ledger.find(r => r.source === "focus" && r.rev === currentRevision);
  if (focusMatch) return focusMatch;

  // Tier 3: Recency (must match revision or be latest)
  const latest = ledger[ledger.length - 1];
  if (latest && (!currentRevision || latest.rev === currentRevision)) {
    return latest;
  }

  return null;
}

export interface QueryPlan {
  intentId: number;
  chartCode?: string;
  form?: string;
  question: string;
  subject?: string;
  scope: "repository" | "subject";
  seeds: string[];
  because: string;
}

export function planQuery(
  intentId: number,
  target: string | undefined,
  question: string,
  mentions: { resolved: { text: string; matches: { entityId: string; name: string; file: string; kind: string }[] }[]; unresolved: string[] },
): QueryPlan | null {
  const intent = intentById(intentId);

  let subject = target;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9_$./#]+/g, " ").trim();
  const normalizedTarget = target ? ` ${normalize(target)} ` : "";
  const targetMention = mentions.resolved
    .filter((m) => normalizedTarget.includes(` ${normalize(m.text)} `))
    .sort((a, b) => b.text.length - a.text.length)[0];
  const namedTarget = !!target?.trim() && !!targetMention?.matches.length && !/^(?:(?:this|the)\s+)?(?:project|repository|repo|system|application|codebase)$/i.test(target.trim());
  const scope = namedTarget || intent.subject !== "repo" ? "subject" : "repository";
  if (intent.subject !== "none" && intent.subject !== "repo") {
    if (targetMention && targetMention.matches.length > 0) {
      subject = targetMention.matches[0].name;
    }
  }

  // The registry is ordered by preference. Select one render target only: sending both a
  // chart code and a fallback visual made askView silently prefer the visual form.
  let primary = intent.primaryChartIds[0];
  if (intentId === 31) {
    const kind = targetMention?.matches[0]?.kind;
    primary = kind === "package" || kind === "module" || kind === "crate" || kind === "workspace" ? "S17"
      : kind === "class" || kind === "interface" || kind === "type" ? "S16"
      : "S21";
  } else if (intentId === 34) {
    const q = question.toLocaleLowerCase();
    primary = /\b(data|schema|database)\b/.test(q) ? "S9"
      : /\b(state|lifecycle|transition)\b/.test(q) ? "S24"
      : /\b(concurren|thread|race)\w*/.test(q) ? "V10"
      : /\b(decision|condition|branch)\w*/.test(q) ? "S11"
      : /\b(test|coverage)\w*/.test(q) ? "S5"
      : /\b(performance|bottleneck|profile)\w*/.test(q) ? "V17"
      : "S12";
  }
  const chartCode = primary?.startsWith("S") ? primary : undefined;
  const form = primary?.startsWith("V") ? primary : undefined;

  return {
    intentId,
    chartCode,
    form,
    question,
    subject,
    scope,
    seeds: namedTarget ? (targetMention?.matches ?? []).map((match) => match.entityId) : [],
    because: `Matched intent: ${intent.intent}`,
  };
}
