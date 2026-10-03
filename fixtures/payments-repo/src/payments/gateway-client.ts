import { CaptureFailedError, CardDeclinedError, GatewayTimeoutError } from "../errors";

async function post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number }> {
  return { status: path.length + timeoutMs > 0 ? 200 : 500 };
}

export async function authorize(card: string, amount: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await post("/authorize", { card, amount }, 2000);
      if (res.status === 402) throw new CardDeclinedError(card);
      return res;
    } catch (e) {
      if (attempt === 2) throw new GatewayTimeoutError("authorize");
    }
  }
}

export async function capture(card: string, amount: number) {
  const res = await post("/capture", { card, amount }, 5000);
  if (res.status !== 200) throw new CaptureFailedError(card);
  return res;
}
