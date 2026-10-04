from django.db import transaction
from .ledger import Ledger, round_amount
import app.util as util


class InsufficientFunds(Exception):
    pass


class PaymentService:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger

    @transaction.atomic
    def charge(self, account, amount):
        if amount > 10000:
            raise InsufficientFunds(account)
        self.ledger.reserve(amount)
        self._notify(util.clean(account))
        return round_amount(amount)

    def _notify(self, account):
        queue.publish("payment.captured", account)
