import { useCallback, useEffect, useState } from "react";
import type { DirListing } from "@cie/schema";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";

interface Props { initialPath?: string; onPick: (path: string) => void; onClose: () => void }

export function FolderPicker({ initialPath, onPick, onClose }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const go = useCallback(async (path?: string) => {
    setLoading(true); setError(null);
    const r = await call<DirListing>("C01", "browseDirectory", { path });
    setLoading(false);
    if (r.ok) setListing(r.value);
    else if (!listing && path) void go(undefined); // bad starting path: fall back to home
    else setError(r.error.message);
  }, [listing]);

  useEffect(() => { void go(initialPath || undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];

  return (
    <Modal
      title="Choose a repository folder"
      onClose={onClose}
      actions={<>
        <span className="mono muted" title={listing?.path}>{listing?.path}</span>
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={!listing} onClick={() => listing && onPick(listing.path)}>Select this folder</button>
      </>}
    >
      <nav className="crumbs" aria-label="Current folder">
        <button className="link" onClick={() => void go("/")}>/</button>
        {crumbs.map((c, i) => (
          <span key={i}><button className="link" onClick={() => void go("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button> / </span>
        ))}
      </nav>
      {error && <div className="banner error" role="alert">{error}</div>}
      <ul className="dirs" aria-busy={loading} tabIndex={0} aria-label="Folders">
        {listing?.parent && <li><button className="dir" onClick={() => void go(listing.parent!)}>⬆ ..</button></li>}
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button className="dir" onClick={() => void go(e.path)}>📁 {e.name}{e.isGitRepo && <span className="badge fact">git repo</span>}</button>
            {e.isGitRepo && <button className="link" onClick={() => onPick(e.path)}>select</button>}
          </li>
        ))}
        {listing && listing.entries.length === 0 && <li className="muted">No subfolders.</li>}
        {listing?.truncated && <li className="muted">List truncated; type a path to go deeper.</li>}
      </ul>
    </Modal>
  );
}
