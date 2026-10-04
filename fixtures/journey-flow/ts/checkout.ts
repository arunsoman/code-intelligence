export function validate(cart: any) { return cart; }
export function shipFast(cart: any) { return cart; }
export function shipSlow(cart: any) { return cart; }
export function reserve(item: any) { return item; }
export function charge(cart: any) { return cart; }
export function backoff() { return 1; }
export function notify(cart: any) { return cart; }

export function checkout(cart: any, items: any[]) {
  validate(cart);
  if (cart.express) {
    shipFast(cart);
  } else {
    shipSlow(cart);
  }
  for (const item of items) {
    reserve(item);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      charge(cart);
      break;
    } catch (e) {
      backoff();
    }
  }
  notify(cart);
}
