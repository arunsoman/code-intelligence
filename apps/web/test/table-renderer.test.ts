import {test} from "node:test";
import assert from "node:assert/strict";
import {compiledTable} from "../../../packages/core/test/table-fixture.ts";
import renderer from "../src/plugins/renderers/table.renderer.ts";
import {rendererForView} from "../src/plugins/renderers/index.ts";
import {tableCellNode} from "../src/table-cell.ts";
test("table descriptors dispatch to table renderer with readable text alternatives",()=>{for(const kind of ["S11","S24","S25"] as const){const v=compiledTable(kind);assert.equal(rendererForView(v).id,"table");const r=renderer.render(v,1,new Map(),new Set());assert.deepEqual(r.table,v.table);assert.match(renderer.textAlternative(v),/Static interpretations/);}});
test("inspection retains row selection identity and isolates cell evidence",()=>{const v=compiledTable("S25"),r=renderer.render(v,5,new Map(),new Set()),row=r.table!.rows[0],c=r.table!.columns[1];const n=tableCellNode(r,row,c,row.cells[1])!;assert.equal(n.id,row.nodeId);assert.deepEqual(n.node!.evidenceIds,[]);assert.equal(n.node!.file,"");assert.equal(n.displayMode,"FOG");assert.match(n.node!.notes![0],/Unknown/);assert.deepEqual(r.nodes[0].node!.evidenceIds,["ev:1"]);});
test("invalid table contract falls back to existing graph without throwing",()=>{const v=compiledTable("S11");assert.equal(renderer.render({...v,table:undefined},5,new Map(),new Set()).table,undefined);});
