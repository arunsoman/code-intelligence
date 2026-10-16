export function initialize(x: any) {
  x.content = {length: 0};
  x.length = 0;
}
export function read(x: any) {
  return x.content.length;
}
