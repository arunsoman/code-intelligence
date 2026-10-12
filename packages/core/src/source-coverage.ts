import type { Entity } from "@cie/schema";
export interface SourceRead { total: number; contentHash: string; ranges: [number, number][] }

/** Inherit source coverage only when a child's entire byte span was delivered in
 * source pages of the same file/hash. Symbol discovery and partial pages do not count. */
export function coveredChildren(parent: Entity, text: string, read: SourceRead, children: Entity[]): { entity: Entity; total: number }[] {
  const span = parent.spans[0];
  if (!span || !["file", "class", "interface"].includes(parent.kind)) return [];
  const base = parent.kind === "file" ? 0 : span.startByte;
  const bytes = Buffer.from(text, "utf8");
  const intervals: [number, number][] = [];
  for (const [start, end] of [...read.ranges].sort((a, b) => a[0] - b[0])) {
    const range: [number, number] = [base + Buffer.byteLength(text.slice(0, start)), base + Buffer.byteLength(text.slice(0, end))];
    const last = intervals.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else intervals.push(range);
  }
  return children.flatMap(entity => {
    const child = entity.spans[0];
    if (entity.entityId === parent.entityId || entity.kind === "file" || entity.file !== parent.file || !child || child.sourceId !== span.sourceId || child.contentHash !== read.contentHash || child.endByteExclusive <= child.startByte) return [];
    if (!intervals.some(([start, end]) => start <= child.startByte && end >= child.endByteExclusive)) return [];
    return [{ entity, total: bytes.subarray(child.startByte - base, child.endByteExclusive - base).toString("utf8").length }];
  });
}
