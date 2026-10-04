import { helper } from "./util";

export class Circle {
  radius = 1;
  area(): number {
    return helper(this.radius) * 3;
  }
}

export function makeCircle(): Circle {
  return new Circle();
}
