import { add, scale } from "./math.ts";

export function total(xs: number[]): number {
  return xs.reduce((sum, x) => add(sum, x), 0);
}

export function doubled(xs: number[]): number[] {
  return xs.map((x) => scale(x, 2));
}

export function summary(xs: number[]): string {
  const t = total(xs);
  return `total ${t}`;
}

export function twice(x: number): number {
  const a = scale(x, 2);
  return scale(a, 3);
}
