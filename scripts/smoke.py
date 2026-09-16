"""Exercise a running RDFscope binary against local data and a controlled SPARQL endpoint.
Usage: python3 scripts/smoke.py [http://127.0.0.1:7878]
Restores the bundled sample at the end. Uses only Python's standard library.
"""
import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7878"
calls = []

def request(path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": "RDFscope-Smoke/0.1", "x-rdfscope-request": "1", "Content-Type": "application/json"}
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, headers=h), timeout=35) as response:
        raw = response.read()
        return json.loads(raw) if "json" in response.headers.get("content-type", "") else raw

def upload(text, filename):
    boundary = "RDFscopeSmokeBoundary"
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n{text}\r\n--{boundary}--\r\n').encode()
    req = urllib.request.Request(BASE + "/api/import", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "x-rdfscope-request": "1", "User-Agent": "RDFscope-Smoke/0.1"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        query = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())["query"][0]
        calls.append((query, self.headers.get("User-Agent"), self.headers.get("Authorization")))
        if self.path == "/broken":
            self.send_response(500); self.end_headers(); return
        if query.startswith("ASK"):
            result = {"head": {}, "boolean": True}
        else:
            uri = lambda x: {"type": "uri", "value": "https://fixture.example/" + x}
            result = {"head": {"vars": ["s", "p", "o", "g"]}, "results": {"bindings": [
                {"s": uri("alice"), "p": uri("knows"), "o": uri("bob"), "g": uri("team")},
                {"s": uri("alice"), "p": {"type": "uri", "value": "http://www.w3.org/2000/01/rdf-schema#label"}, "o": {"type": "literal", "value": "Alice", "xml:lang": "en"}, "g": uri("team")},
            ]}}
        body = json.dumps(result).encode()
        self.send_response(200); self.send_header("Content-Type", "application/sparql-results+json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

fixture = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
thread = threading.Thread(target=fixture.serve_forever, daemon=True); thread.start()
try:
    assert b"RDFscope" in request("/")
    s = upload('@prefix ex: <https://ex/> . ex:g { ex:alice ex:knows ex:bob; ex:age 42; ex:name "Alice"@en . }', "test.trig")
    assert s["triples"] == 3 and s["graphs"][0]["id"] == "https://ex/g"
    d = request("/api/resource?id=https%3A%2F%2Fex%2Falice")
    assert any(x["object"].get("language") == "en" for x in d["outgoing"])
    inspected = request("/api/inspect", {"id": "https://ex/alice"})
    assert len(inspected["outgoing"]) == 2 and not inspected["properties_more"]
    page = request("/api/neighborhood", {"id": "https://ex/alice", "graph": "https://ex/g", "direction": "outgoing"})
    assert page["total"] == 1 and not page["has_more"] and page["scope"] == "local"
    groups = request("/api/relations", {"id": "https://ex/alice"})
    assert groups["groups"][0]["count"] == 1
    found = request("/api/search", {"q": "alice", "limit": 1})
    assert found["items"][0]["id"] == "https://ex/alice"
    try:
        request("/api/neighborhood", {"id": "https://ex/alice", "predicate": "invalid iri"})
        raise AssertionError("Invalid predicate accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400

    assert request("/api/query", {"query": "ASK { GRAPH ?g { ?s ?p ?o } }"})["value"] is True
    exported = request("/api/export").decode()
    assert "https://ex/g" in exported
    assert upload(exported, "roundtrip.nq")["triples"] == 3
    try:
        upload("this is invalid turtle", "broken.ttl")
        raise AssertionError("Invalid import accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400
    assert request("/api/summary")["triples"] == 3, "Invalid import replaced existing data"
    for query in ["DELETE WHERE {?s ?p ?o}", "not a query"]:
        try:
            request("/api/query", {"query": query}); raise AssertionError("Invalid query accepted")
        except urllib.error.HTTPError as error:
            assert error.code == 400
    url = f"http://127.0.0.1:{fixture.server_port}/sparql"
    remote = request("/api/connect", {"url": url, "token": "fixture-only-token"})
    assert remote["sampled"] and remote["triples"] == 2
    assert "fixture-only-token" not in json.dumps(remote)
    assert calls[-1][1] == "RDFscope/0.1" and calls[-1][2] == "Bearer fixture-only-token"
    assert request("/api/query", {"query": "ASK { ?s ?p ?o }"})["value"] is True
    expanded = request("/api/expand", {"id": "https://fixture.example/alice"})
    assert len(expanded["nodes"]) == 2
    assert len(expanded["edges"]) == 1
    trace = request("/api/trace")
    assert len(trace) == 3 and all(entry["status"] == "ok" for entry in trace)
    assert "fixture-only-token" not in json.dumps(trace)
    request("/api/trace/clear", {})
    assert request("/api/trace") == []

    try:
        request("/api/connect", {"url": url.replace("/sparql", "/broken")}); raise AssertionError("Broken endpoint accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400
    assert request("/api/summary")["endpoint"] == url
    try:
        request("/api/sample", {}, {"Origin": "https://untrusted.example"}); raise AssertionError("Cross-origin mutation accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 403
    print("PASS: embedded UI, RDF import, named graphs, literals, SPARQL, export roundtrip, atomic errors, paged browsing/search/inspection, endpoint connection/auth/expansion, trace/token privacy, local origin guard")
finally:
    request("/api/sample", {})
    fixture.shutdown(); fixture.server_close(); thread.join(timeout=2)
