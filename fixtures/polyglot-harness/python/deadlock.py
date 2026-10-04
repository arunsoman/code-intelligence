import threading
import time

accounts = threading.Lock()
ledger = threading.Lock()


def forward():
    with accounts:
        time.sleep(0.2)
        with ledger:
            pass


def backward():
    with ledger:
        time.sleep(0.2)
        with accounts:
            pass


# Planted: opposite orders, with a pause that makes the overlap certain.
threads = [threading.Thread(target=forward, name="forward"), threading.Thread(target=backward, name="backward")]
for t in threads:
    t.start()
for t in threads:
    t.join()
