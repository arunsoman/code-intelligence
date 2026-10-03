type Handler = (payload: any) => Promise<void>;
const handlers = new Map<string, Handler[]>();

export const queue = {
  publish(topic: string, payload: unknown) {
    for (const h of handlers.get(topic) ?? []) void h(payload);
  },
  subscribe(topic: string, handler: Handler) {
    handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
  },
};
