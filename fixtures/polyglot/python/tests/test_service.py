from app.service import PaymentService


def test_charges_account():
    PaymentService(None).charge("a", 1)
