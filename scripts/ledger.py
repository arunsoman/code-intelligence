#!/usr/bin/env python3
"""ledger.py C02 0 'test title fragment' ['another'] ...   mark an item done with the tests that prove it.
ledger.py block C17 4 'needs ...'                          mark an item blocked and say what it needs."""
import json, sys
p = "docs/ledger.json"
l = json.load(open(p))
if sys.argv[1] == "block":
    _, _, c, i, needs = sys.argv
    l[c]["items"][int(i)].update(state="blocked", needs=needs)
elif sys.argv[1] == "add":
    _, _, c, text = sys.argv[:4]
    l[c]["items"].append({"item": text, "tests": sys.argv[4:], "state": "done" if sys.argv[4:] else "open"})
else:
    c, i, *tests = sys.argv[1:]
    l[c]["items"][int(i)].update(state="done", tests=tests)
json.dump(l, open(p, "w"), indent=1)
