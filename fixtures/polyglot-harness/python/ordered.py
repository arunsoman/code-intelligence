import threading
import time

accounts = threading.Lock()
ledger = threading.Lock()


def work():
    with accounts:
        time.sleep(0.05)
        with ledger:
            pass


# Safe: both threads take accounts then ledger.
threads = [threading.Thread(target=work) for _ in range(2)]
for t in threads:
    t.start()
for t in threads:
    t.join()
