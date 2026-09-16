"""Run a loopback SPARQL endpoint backed by a disposable RDFscope process.

Usage: python3 scripts/endpoint_fixture.py [path/to/rdfscope]
Prints the endpoint URL. Ctrl+C removes the fixture and stops its child process.
This developer fixture uses the app's query API and its 1,000-row result limit.
"""
import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

binary = Path(sys.argv[1] if len(sys.argv) > 1 else "target/release/rdfscope").resolve()
with tempfile.TemporaryDirectory(prefix="rdfscope-endpoint-") as directory:
    path = Path(directory) / "discovery.trig"
    rdf = ['@prefix e: <https://discovery.example/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
           'e:root rdfs:label "Discovery library" . e:review e:mentions e:root .']
    for n in range(137):
        rdf.append(f'e:catalog {{ e:root e:contains e:book{n:03} . e:book{n:03} a <https://schema.org/Book> ; rdfs:label "Discovery {n:03}"@en . }}')
    rdf.append('e:archive { e:root e:contains e:book000 . }')
    path.write_text("\n".join(rdf))
    child = subprocess.Popen([str(binary), str(path), "--no-open", "--port", "0"], stdout=subprocess.PIPE, text=True)
    server = None
    try:
        base = None
        for line in child.stdout:
            match = re.search(r"http://127\.0\.0\.1:\d+", line)
            if match:
                base = match.group(); break
        if not base:
            raise RuntimeError("Fixture RDFscope process did not start")

        class Endpoint(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                query = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())["query"][0]
                if self.path == "/broken":
                    self.send_error(503); return
                req = urllib.request.Request(base + "/api/query", data=json.dumps({"query": query}).encode(), headers={"Content-Type": "application/json", "x-rdfscope-request": "1", "User-Agent": "RDFscope-Fixture/0.1"})
                try:
                    with urllib.request.urlopen(req, timeout=35) as response:
                        result = json.load(response)
                    if result["kind"] == "boolean":
                        payload = {"head": {}, "boolean": result["value"]}
                    else:
                        rows = []
                        for row in result["rows"]:
                            converted = {}
                            for key, term in row.items():
                                value = {"type": term["kind"], "value": term["value"]}
                                if term.get("language"):
                                    value["xml:lang"] = term["language"]
                                elif term.get("datatype"):
                                    value["datatype"] = term["datatype"]
                                if value["type"] == "bnode":
                                    value["value"] = value["value"].removeprefix("_:")
                                converted[key] = value
                            rows.append(converted)
                        payload = {"head": {"vars": result["columns"]}, "results": {"bindings": rows}}
                    body = json.dumps(payload).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/sparql-results+json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                except Exception:
                    self.send_error(502, "Fixture query failed")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
        print(f"Endpoint: http://127.0.0.1:{server.server_port}/sparql", flush=True)
        print("Seed IRI: https://discovery.example/root", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
        child.stdout.close()
