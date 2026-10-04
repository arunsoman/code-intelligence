import { queue } from "./bus";

export function capture(payload: unknown) { queue.publish("payment.capture.requested", payload); }
export function audit(payload: unknown) { queue.publish("audit.logged", payload); }
export function listen() { queue.subscribe("payment.capture.requested", onCapture); queue.subscribe("never.published", onCapture); }
function onCapture(msg: unknown) { return msg; }
