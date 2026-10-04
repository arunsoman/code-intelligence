class Ledger:
    def __init__(self):
        self.balance = 0

    def reserve(self, amount):
        self.balance -= amount
        self._record(amount)

    def _record(self, amount):
        pass


def round_amount(x):
    return x
