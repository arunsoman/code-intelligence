// Deterministic static-analysis fixture. No real telemetry service is contacted.
export class Counter {
  private value = 0;
  add(amount: number): void { this.value += amount; }
}
export class Meter {
  createCounter(_name: string): Counter { return new Counter(); }
}
export class Ledger {
  private entries: string[] = [];
  append(paymentId: string): void { this.entries.push(paymentId); }
}
export class PaymentService {
  constructor(private ledger: Ledger, private meter: Meter) {}
  submit(paymentId: string): void {
    const counter = this.meter.createCounter("payment.submitted");
    this.ledger.append(paymentId);
    counter.add(1);
  }
  retry(paymentId: string): void {
    const counter = this.meter.createCounter("payment.retried");
    this.ledger.append(paymentId);
    counter.add(1);
  }
}
export function submitPayment(paymentId: string): void {
  const service = new PaymentService(new Ledger(), new Meter());
  service.submit(paymentId);
}
