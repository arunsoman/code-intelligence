from flask import Flask
from flask_login import login_required

app = Flask(__name__)


class Db:
    def delete(self, key):
        self.rows = {}


db = Db()


# Planted: anyone can delete.
@app.delete("/items/<key>")
def delete_item(key):
    db.delete(key)
    return "gone"


# Safe: login required.
@app.delete("/admin/items/<key>")
@login_required
def admin_delete_item(key):
    db.delete(key)
    return "gone"
