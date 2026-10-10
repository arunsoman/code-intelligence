import type { NavigationCrumb } from "./exploration-navigation.ts";
export function NavigationBreadcrumbs(p:{ crumbs:NavigationCrumb[]; truncated:boolean; sourceTitle?:string; onJump:(index:number)=>void }) {
 if (!p.crumbs.length) return null;
 return <nav className="navigation-breadcrumbs" aria-label="Exploration path">
  {p.truncated && <p className="muted small">Earlier exploration steps were omitted; the latest 30 parent scopes are retained.</p>}
  <ol>{p.crumbs.map(c=><li key={`${c.index}:${c.revision}`}><button type="button" className="link" disabled={c.current&&!p.sourceTitle} aria-current={c.current&&!p.sourceTitle ? "page" : undefined} title={`${c.label} · ${c.perspective}`} onClick={()=>p.onJump(c.index)}><span>{c.label}</span><small>{c.perspective}</small></button></li>)}
   {p.sourceTitle && <li><span aria-current="page"><span>{p.sourceTitle}</span><small>Source code</small></span></li>}
  </ol>
 </nav>;
}
