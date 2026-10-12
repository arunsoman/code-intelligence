// Tagged errors, REA-style: a caller can branch on the code instead of parsing sentences. The HTTP
// layer maps INVALID_SCHEMA / ID_MISMATCH / DIGEST_MISMATCH onto the gateway's INVALID_SCHEMA answer,
// so a tampered bundle is refused before any of it is stored.
export type ReEvidenceErrorCode = "INVALID_SCHEMA" | "ID_MISMATCH" | "DIGEST_MISMATCH" | "UNKNOWN_STATUS";

export class ReEvidenceError extends Error {
  readonly code: ReEvidenceErrorCode;
  constructor(code: ReEvidenceErrorCode, message: string) {
    super(message);
    this.name = "ReEvidenceError";
    this.code = code;
  }
}
