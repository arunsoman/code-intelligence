import { useMemo, useState, type KeyboardEvent } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Guide = {
  naming: { className: string; packagePath: string; serviceName: string; channelName: string };
  steps: { id: string; title: string; recommendation: string; defaultValue: string; code: string }[];
  checklist: string[]; sql: string; nextSteps: string[];
};
type Response = { guide: Guide | null; source: string; model: string | null; message: string };
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);

function markdown(name: string, guide: Guide) {
  return `# ${name} provider guide\n\n> ${guide.naming.className} · service ${guide.naming.serviceName} · channel ${guide.naming.channelName}\n\n## Checklist\n\n${guide.checklist.map((x) => `- [ ] ${x}`).join("\n")}\n\n## Naming convention\n\n- Class: \`${guide.naming.className}\`\n- Package/path: \`${guide.naming.packagePath}\`\n- Service name: \`${guide.naming.serviceName}\`\n- Channel: \`${guide.naming.channelName}\`\n\n${guide.steps.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.recommendation}\n\n**Recommended default:** ${s.defaultValue}\n\n\x60\x60\x60\n${s.code}\n\x60\x60\x60`).join("\n\n")}\n\n## Database record\n\n\x60\x60\x60sql\n${guide.sql}\n\x60\x60\x60\n\n## What to do next\n\n${guide.nextSteps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`;
}

export function ProviderWizard({ onClose, revision: _revision }: { onClose: () => void; revision?: string }) {
  const [step, setStep] = useState<Step>(0);
  const [rawName, setRawName] = useState("");
  const [result, setResult] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const name = clean(rawName);
  const titles = useMemo(() => result?.guide ? ["Provider name", ...result.guide.steps.map((s) => s.title), "Final summary & download"] : ["Provider name", "Waiting for LLM guide"], [result]);
  const guide = result?.guide ?? null;

  const requestGuide = async () => {
    if (!name) return;
    setLoading(true); setError(null); setResult(null);
    const r = await call<Response>("C19", "providerGuide", { providerName: name });
    setLoading(false);
    if (!r.ok) { setError(r.error.message); return; }
    setResult(r.value);
    if (r.value.guide) setStep(1); else setError(r.value.message);
  };
  const next = () => {
    if (step === 0) { void requestGuide(); return; }
    if (step < titles.length - 1) setStep((step + 1) as Step);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && !loading && step < titles.length - 1 && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); next(); }
  };
  const content = guide ? markdown(name, guide) : "";
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${name.toLowerCase()}-provider-guide.md`; a.click(); URL.revokeObjectURL(url);
  };
  const copy = async () => { await navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };

  const body = () => {
    const stepIndicator = <p className="muted small provider-step-indicator">{name ? `${name} · ` : ""}{titles[step]}{guide ? ` (step ${step + 1} of ${total})` : ""}</p>;
    if (step === 0) return <><FormField label="Provider name" htmlFor="provider-name" required helper="The configured LLM will propose the wizard steps after you continue. Spaces and punctuation are removed; the name is uppercased."><input id="provider-name" autoFocus value={rawName} onChange={(e) => setRawName(e.target.value)} placeholder="MTN, ROSHAN, New Co" /></FormField></>;
    if (!guide) return <>{stepIndicator}<p>{loading ? "Asking the configured LLM to prepare the provider guide…" : result?.message ?? "The guide could not be generated."}</p>{error && <div className="banner error" role="alert">{error}</div>}<button className="secondary" disabled={loading || !name} onClick={() => void requestGuide()}>Try again</button></>;
    if (step === titles.length - 1) return <>{stepIndicator}<p>{result?.message}</p><p className="muted small">Source: {result?.source}{result?.model ? ` · ${result.model}` : ""}</p><h4>Files to create or modify</h4><ul>{guide.checklist.map((x) => <li key={x}>{x}</li>)}</ul><div className="row"><button onClick={() => void copy()}>{copied ? "Copied" : "Copy Markdown"}</button><button className="secondary" onClick={download}>Download Markdown</button></div><details open><summary>All generated recommendations and code</summary><pre className="provider-code">{content}</pre></details></>;
    const s = guide.steps[step - 1]!;
    return <>{stepIndicator}<p>{s.recommendation}</p><p><strong>Recommended default:</strong> {s.defaultValue}</p><details open><summary>Generated template</summary><pre className="provider-code">{s.code}</pre></details></>;
  };

  const total = titles.length;
  return <Modal title="Create provider" onClose={onClose} className="wide tall provider-wizard" actions={<><span className="muted small">Step {step + 1}{guide ? ` of ${total}` : " · LLM planning"}</span>{step > 0 && guide && <button className="secondary" disabled={loading} onClick={() => setStep((step - 1) as Step)}>Back</button>}{step === 0 ? <button disabled={!name || loading} onClick={next}>{loading ? "Generating…" : "Continue"}</button> : guide && step < total - 1 ? <button onClick={next}>Yes / Continue</button> : guide ? <button onClick={onClose}>Done</button> : null}</>}>
    <div onKeyDown={onKeyDown} className="provider-step">{guide && <div className="provider-progress" aria-label={`Step ${step + 1} of ${total}`}>{Array.from({ length: total }, (_, i) => <span key={i} className={i <= step ? "active" : ""} />)}</div>}<h3>{titles[step]}</h3>{body()}</div>
  </Modal>;
}
