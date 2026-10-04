import logging
import sqlite3
import threading

logger = logging.getLogger(__name__)
accounts = threading.Lock()
ledger = threading.Lock()


# Planted: accounts then ledger here, ledger then accounts below.
def forward():
    with accounts:
        with ledger:
            audit()


def backward():
    with ledger:
        with accounts:
            audit()


# Safe: the same order everywhere.
def also_forward():
    with accounts:
        with ledger:
            audit()


# Planted: acquire without a finally.
def guarded():
    ledger.acquire()
    audit()
    ledger.release()


# Safe: released in finally.
def guarded_safely():
    ledger.acquire()
    try:
        audit()
    finally:
        ledger.release()


# Planted: one query per id, twice (a loop and a comprehension).
def totals(cursor, ids):
    out = []
    for user_id in ids:
        cursor.execute("select * from orders where user_id = ?", (user_id,))
        out.append(cursor.fetchall())
    return out


def names(session, ids):
    return [session.query(User).get(i) for i in ids]


# Safe: one query for everything.
def totals_batch(cursor, ids):
    cursor.execute("select * from orders where user_id in (%s)" % ",".join("?" * len(ids)), ids)
    return cursor.fetchall()


# Planted: neither is closed.
def first_line(path):
    f = open(path)
    return f.readline()


def count_rows(db_path):
    conn = sqlite3.connect(db_path)
    return conn.execute("select count(*) from t").fetchone()


# Safe.
def first_line_safely(path):
    with open(path) as f:
        return f.readline()


# Planted: the password and token are logged, one inside an f-string.
def login(email, password, token):
    logging.info("login %s %s", email, password)
    logger.info(f"token {token}")


# Safe: a length only.
def login_safely(password):
    logger.info("password length %d", len(password))


def audit():
    pass


class User:
    pass
