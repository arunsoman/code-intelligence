import { useEffect, useId, useRef, useState } from "react";
import type { ApiResult } from "@cie/schema";

/**
 * The status chip, made clickable: it opens every model `ollama list` reports, the current one marked, and
 * switches live on a click — no config file, no restart, no name baked into the app. There is no fallback
 * default shown here either: a repository with nothing installed says so, with the command to fix it.
 */
type ListModels = { installed: string[]; current: string | null; hosted: boolean; reachable: boolean };

type ModelMenuProps = {
  current: string | null;
  hosted: boolean;
  call: <T>(component: string, op: string, body?: unknown, idempotencyKey?: string) => Promise<ApiResult<T>>;
  onChanged: () => void | Promise<void>;
};

export function ModelMenu({ current, hosted, call, onChanged }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListModels | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const reveal = async () => {
    setOpen((v) => !v);
    if (open || busy) return;
    setList(null); setError(null);
    const r = await call<ListModels>("C01", "listModels");
    if (r.ok) setList(r.value); else setError(r.error.message);
  };

  const pick = async (model: string) => {
    if (model === current) { setOpen(false); return; }
    setBusy(model); setError(null);
    const r = await call<{ model: string; hosted: boolean }>("C01", "setModel", { model }, crypto.randomUUID());
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setOpen(false);
    setList(null); // refetched next open, so a stale "current" never lingers
    await onChanged();
  };

  return (
    <span className="model-menu" ref={boxRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chip chip-button model-menu__trigger"
        title="Model provider — click to choose another from what Ollama has installed"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => void reveal()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); } }}
      >
        {current ?? "no model"}{hosted ? " · hosted" : ""} ▾
      </button>
      {open && (
        <div id={id} className="model-menu__panel" role="listbox" aria-label="Installed Ollama models">
          {!list && !error && <p className="muted small" role="status">checking ollama list…</p>}
          {error && <p className="error small" role="alert">{error}</p>}
          {list && list.installed.length === 0 && (
            <p className="muted small">{list.reachable ? "Ollama has no model installed; run `ollama pull <name>`." : "Ollama is not reachable at the configured address."}</p>
          )}
          {list?.installed.map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === current}
              className={`model-menu__option ${m === current ? "sel" : ""}`}
              disabled={busy === m}
              onClick={() => void pick(m)}
            >
              <span className="mono">{m}</span>
              <span className="muted small">{/[:-]cloud$/.test(m) ? "cloud" : "local"}</span>
              {m === current && <span className="muted small">current</span>}
              {busy === m && <span className="muted small">switching…</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
