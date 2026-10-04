def validate(cart):
    return cart


def ship_fast(cart):
    return cart


def reserve(item):
    return item


def charge(cart):
    return cart


def notify(cart):
    return cart


def place_order(cart, items):
    validate(cart)
    if cart.express:
        ship_fast(cart)
    for item in items:
        reserve(item)
    for attempt in range(3):
        try:
            charge(cart)
            break
        except Exception:
            continue
    notify(cart)
