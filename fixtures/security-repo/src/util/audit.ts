export function maskEmail(email: string): string {
  return email.replace(/(.).+(@.*)/, "$1***$2");
}
export function hashId(value: string): string {
  let h = 0;
  for (const c of value) h = (h * 31 + c.charCodeAt(0)) | 0;
  return String(h);
}
