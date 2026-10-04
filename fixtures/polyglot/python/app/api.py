from flask import Flask
from .service import PaymentService

app = Flask(__name__)


@app.post("/payments")
def create_payment(service: PaymentService):
    return service.charge("acct", 5)


@app.get("/health")
def health():
    return "ok"


def dynamic(obj, name):
    return getattr(obj, name)()
