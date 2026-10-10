import { ResponseManifestSchema } from "@cie/schema";
import { LENS_DEFAULTS } from "./fisheye.ts";
import type { NavigationHistory } from "./exploration-navigation.ts";
import type { ResponseWorkspace, TabState } from "./response-workspace.ts";
const LIMIT = 1_000_000;
const uiState = (value: unknown): TabState | undefined => {
 if(!value || typeof value!=="object") return;
 const ui=value as TabState;
 const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=200&&v.every(x=>typeof x==="string"&&x.length<=1000);
 if(!ids(ui.selection)||!ids(ui.cellSelection)||!Number.isInteger(ui.level)||ui.level<0||ui.level>5||!["matrix","graph"].includes(ui.drawMode))return;
 const weights=Object.entries(ui.terrainWeights??{}).filter(([,v])=>typeof v==="number"&&Number.isFinite(v)).slice(0,30);
 const canvas=ui.canvas;
 const valid=canvas && Number.isFinite(canvas.zoom)&&canvas.zoom>0&&canvas.zoom<=100&&Number.isFinite(canvas.pan?.x)&&Number.isFinite(canvas.pan?.y);
 return {selection:ui.selection,...(ids(ui.selectionRefs)?{selectionRefs:ui.selectionRefs}:{}),cellSelection:ui.cellSelection,level:ui.level,drawMode:ui.drawMode,terrainWeights:Object.fromEntries(weights),...(valid?{canvas:{zoom:canvas.zoom,pan:{x:canvas.pan.x,y:canvas.pan.y},lens:{...LENS_DEFAULTS,enabled:canvas.lens?.enabled!==false}}}:{})};
};
/** Save navigation recipes and camera/selection only. Source specs and claims are regenerated. */
export function encodeCheckpoint(workspace: ResponseWorkspace, navigation: NavigationHistory): string | undefined {
 const frame=(w:ResponseWorkspace)=>({manifest:{...w.manifest,sections:[],subjectRefs:[],limitations:[],interpretation:"Restoring this response from current evidence…"},activeId:w.activeId,navigationLabel:w.navigationLabel,tabs:w.tabs.map(t=>({id:t.id,open:t.open,ui:uiState(t.ui ? {...t.ui, selectionRefs:t.view ? [...new Set(t.view.nodes.filter(n=>t.ui!.selection.includes(n.id)).flatMap(n=>n.entityRefs))].slice(0,200) : t.ui.selectionRefs} : undefined)}))});
 const data=JSON.stringify({schemaVersion:"checkpoint.v1",workspace:frame(workspace),ancestors:navigation.ancestors.slice(-30).map(frame),truncated:navigation.truncated});
 return data.length<=LIMIT?data:undefined;
}
export function decodeCheckpoint(text: string, revision: string): {workspace:ResponseWorkspace;navigation:NavigationHistory}|undefined {
 if(text.length>LIMIT)return;
 try {
  const raw=JSON.parse(text);
  if(raw.schemaVersion!=="checkpoint.v1"||!Array.isArray(raw.ancestors)||raw.ancestors.length>30)return;
  const frame=(value:any):ResponseWorkspace=>{
   const manifest=ResponseManifestSchema.parse(value.manifest);
   if(manifest.revision!==revision||!Array.isArray(value.tabs)||value.tabs.length!==manifest.views.length||!manifest.views.some(t=>t.id===value.activeId))throw new Error("Invalid checkpoint scope");
   const saved=new Map<string,any>(value.tabs.map((t:any)=>[t.id,t]));
   if(saved.size!==manifest.views.length||manifest.views.some(t=>!saved.has(t.id)))throw new Error("Invalid checkpoint tabs");
   const tabs=manifest.views.map(t=>({...t,viewId:undefined,status:t.status==="unavailable"?"unavailable" as const:"available" as const,open:saved.get(t.id).open===true||t.id===value.activeId,claims:[],attempt:1,ui:uiState(saved.get(t.id).ui)}));
   if(tabs.find(t=>t.id===value.activeId)?.status==="unavailable")throw new Error("Unavailable active tab");
   return {manifest,activeId:value.activeId,tabs,...(typeof value.navigationLabel==="string"?{navigationLabel:value.navigationLabel.slice(0,300)}:{})};
  };
  return {workspace:frame(raw.workspace),navigation:{ancestors:raw.ancestors.map(frame),truncated:raw.truncated===true}};
 }catch{return;}
}
