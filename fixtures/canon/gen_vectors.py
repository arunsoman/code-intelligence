#!/usr/bin/env python3
"""Generates canon-vectors.json for pf-canon-v1. Canonical strings are written by hand below; digests come from hashlib,
an implementation independent of the TypeScript and Rust ones. Re-run after editing: python3 gen_vectors.py"""
import hashlib, json, os

def digest(schema, version, canonical):
    pre = b"pf-canon-v1\0" + schema.encode() + b"\0" + version.encode() + b"\0" + canonical.encode("utf-8")
    return hashlib.sha256(pre).hexdigest()

V = []
def h(id, input_text, canonical, schema="t.record", version="1", **kw):
    V.append(dict(id=id, op="hash", schema=schema, version=version, inputText=input_text, expectedCanonical=canonical,
                  expectedDigest=digest(schema, version, canonical), **kw))
def rej(id, code, **kw): V.append(dict(id=id, op="reject", expectError=code, **kw))

# --- ordering and structure
h("keys-order-a", '{"b":1,"a":2}', '{"a":2,"b":1}')
h("keys-order-b", '{"a":2,"b":1}', '{"a":2,"b":1}')
h("array-order-1", '{"x":[1,2,3]}', '{"x":[1,2,3]}')
h("array-order-2", '{"x":[3,2,1]}', '{"x":[3,2,1]}')
h("set-order-1", '{"x":{"$set":["b","a","c"]}}', '{"x":["a","b","c"]}')
h("set-order-2", '{"x":{"$set":["c","b","a"]}}', '{"x":["a","b","c"]}')
h("set-of-objects", '{"x":{"$set":[{"k":2},{"k":1}]}}', '{"x":[{"k":1},{"k":2}]}')
h("null-present", '{"a":null}', '{"a":null}')
h("null-omitted", '{}', '{}')
h("nested-empty", '{"a":{},"b":[],"c":[{}]}', '{"a":{},"b":[],"c":[{}]}')
h("scalars", '{"t":true,"f":false,"n":-5,"max":9007199254740991,"min":-9007199254740991,"z":0}',
  '{"f":false,"max":9007199254740991,"min":-9007199254740991,"n":-5,"t":true,"z":0}')
rej("set-duplicate", "DUPLICATE_SET_ELEMENT", inputText='{"x":{"$set":["a","a"]}}')

# --- strings
h("escape-controls", '{"s":"a\\u0000b\\u001fc\\nd\\te\\"f\\\\g/h"}', '{"s":"a\\u0000b\\u001fc\\u000ad\\u0009e\\"f\\\\g/h"}')
h("no-escape-nonascii", '{"s":"é€😀 \u007f"}', '{"s":"é€😀 \u007f"}')
h("composed", '{"s":"é"}', '{"s":"é"}')
h("decomposed", '{"s":"é"}', '{"s":"é"}')
h("surrogate-pair-escape", '{"s":"\\ud83d\\ude00"}', '{"s":"\U0001F600"}')
h("no-trim-no-newline-fold", '{"s":" a\\r\\n "}', '{"s":" a\\u000d\\u000a "}')

# --- domain separation and included fields
h("schema-a", '{"a":1}', '{"a":1}', schema="t.one")
h("schema-b", '{"a":1}', '{"a":1}', schema="t.two")
h("version-1", '{"a":1}', '{"a":1}', version="1")
h("version-2", '{"a":1}', '{"a":1}', version="2")
h("proj-label-x", '{"id":"r1","expiresAt":"2027-01-01T00:00:00Z","label":"X"}', '{"expiresAt":"2027-01-01T00:00:00Z","id":"r1"}', project=["id", "expiresAt"])
h("proj-label-y", '{"id":"r1","expiresAt":"2027-01-01T00:00:00Z","label":"Y"}', '{"expiresAt":"2027-01-01T00:00:00Z","id":"r1"}', project=["id", "expiresAt"])
h("proj-expiry-changed", '{"id":"r1","expiresAt":"2027-02-01T00:00:00Z","label":"X"}', '{"expiresAt":"2027-02-01T00:00:00Z","id":"r1"}', project=["id", "expiresAt"])
h("proj-model-ref-1", '{"id":"r1","model":"m@1"}', '{"id":"r1","model":"m@1"}', project=["id", "model"])
h("proj-model-ref-2", '{"id":"r1","model":"m@2"}', '{"id":"r1","model":"m@2"}', project=["id", "model"])

# --- rejections at the ingress parser / canonicalizer
rej("dup-key", "DUPLICATE_KEY", inputText='{"a":1,"a":2}')
rej("dup-key-nested", "DUPLICATE_KEY", inputText='{"o":{"k":1,"k":1}}')
rej("unsafe-int", "UNSAFE_NUMBER", inputText='{"n":9007199254740992}')
rej("unsafe-int-neg", "UNSAFE_NUMBER", inputText='{"n":-9007199254740992}')
rej("float", "UNSAFE_NUMBER", inputText='{"n":1.5}')
rej("exponent", "UNSAFE_NUMBER", inputText='{"n":1e3}')
rej("float-zero", "UNSAFE_NUMBER", inputText='{"n":0.0}')
rej("negative-zero", "NEGATIVE_ZERO", inputText='{"n":-0}')
rej("lone-high-surrogate", "BAD_STRING", inputText='{"s":"\\ud800"}')
rej("lone-low-surrogate", "BAD_STRING", inputText='{"s":"\\udc00x"}')
rej("invalid-utf8", "BAD_UTF8", inputHex="7b2261223a22ff227d")
rej("non-ascii-key", "BAD_KEY", inputText='{"é":1}')
rej("empty-key", "BAD_KEY", inputText='{"":1}')
rej("trailing-garbage", "BAD_JSON", inputText='{"a":1} x')
rej("raw-control-in-string", "BAD_JSON", inputText='{"a":"\u0001"}')

# --- decimals
for i, (inp, out) in enumerate([("1.5", "1.5"), ("1.50", "1.5"), ("001.5", "1.5"), ("+1.5", "1.5"), ("0", "0"), ("-0", "0"),
                                ("0.0", "0"), ("-0.00", "0"), ("10", "10"), ("-12.340", "-12.34"), ("100.000", "100")]):
    V.append(dict(id=f"decimal-{i}", op="decimal", input=inp, expected=out))
for i, inp in enumerate(["1e3", "1.", ".5", "", "--1", "1,5", "0x10", " 1"]):
    V.append(dict(id=f"decimal-bad-{i}", op="decimal", input=inp, expectError="BAD_DECIMAL"))

# --- raw artifacts: exact bytes, newline/encoding differences matter, no canonicalisation
for id, hx in [("raw-lf", "6c696e650a"), ("raw-crlf", "6c696e650d0a"), ("raw-bom", "efbbbf6c696e650a"), ("raw-empty", "")]:
    V.append(dict(id=id, op="raw", inputHex=hx, expectedDigest=hashlib.sha256(bytes.fromhex(hx)).hexdigest()))

# --- content root
F = "a" * 64; G = "b" * 64
def root(id, entries, **kw):
    # Independent preimage: entries sorted by UTF-8 path bytes, keys sorted, fields per kind.
    rows = []
    for e in sorted(entries, key=lambda e: e["path"].encode()):
        r = {k: v for k, v in e.items()}
        rows.append(r)
    def ser(o):
        return "{" + ",".join(json.dumps(k) + ":" + json.dumps(o[k], ensure_ascii=False) for k in sorted(o)) + "}"
    canonical = "[" + ",".join(ser(r) for r in rows) + "]"
    V.append(dict(id=id, op="root", entries=entries, expectedCanonical=canonical, expectedDigest=digest("pf.contentRoot", "1", canonical), **kw))
root("root-order-1", [dict(path="src/a.ts", kind="file", mode="100644", hash=F), dict(path="README.md", kind="file", mode="100644", hash=G)])
root("root-order-2", [dict(path="README.md", kind="file", mode="100644", hash=G), dict(path="src/a.ts", kind="file", mode="100644", hash=F)])
root("root-exec-bit", [dict(path="run.sh", kind="file", mode="100755", hash=F)])
root("root-symlink", [dict(path="l", kind="symlink", mode="120000", target="src/a.ts")])
root("root-submodule", [dict(path="vendor/x", kind="submodule", mode="160000", commit="c" * 40)])
root("root-utf8-byte-order", [dict(path="\U0001F600.txt", kind="file", mode="100644", hash=F), dict(path="￮.txt", kind="file", mode="100644", hash=G)])
V.append(dict(id="root-collision-case", op="root", entries=[dict(path="A.ts", kind="file", mode="100644", hash=F), dict(path="a.ts", kind="file", mode="100644", hash=G)], expectError="BAD_PATH"))
V.append(dict(id="root-traversal", op="root", entries=[dict(path="../x", kind="file", mode="100644", hash=F)], expectError="BAD_PATH"))
V.append(dict(id="root-absolute", op="root", entries=[dict(path="/etc/x", kind="file", mode="100644", hash=F)], expectError="BAD_PATH"))
V.append(dict(id="root-bad-mode", op="root", entries=[dict(path="x", kind="file", mode="120000", hash=F)], expectError="BAD_SCHEMA"))

relations = [
  dict(same=["keys-order-a", "keys-order-b"]), dict(different=["array-order-1", "array-order-2"]), dict(same=["set-order-1", "set-order-2"]),
  dict(different=["null-present", "null-omitted"]), dict(different=["composed", "decomposed"]), dict(different=["schema-a", "schema-b"]),
  dict(different=["version-1", "version-2"]), dict(same=["proj-label-x", "proj-label-y"]), dict(different=["proj-label-x", "proj-expiry-changed"]),
  dict(different=["proj-model-ref-1", "proj-model-ref-2"]), dict(different=["raw-lf", "raw-crlf"]), dict(same=["root-order-1", "root-order-2"]),
  dict(different=["root-symlink", "root-submodule"]),
]
out = dict(protocol="pf-canon-v1", note="digests computed by gen_vectors.py with hashlib; sets are written {\"$set\":[...]}; 'project' lists the identity fields kept from the top-level object", vectors=V, relations=relations)
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "canon-vectors.json"), "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False); f.write("\n")
print(len(V), "vectors")
