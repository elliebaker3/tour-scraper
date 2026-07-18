"""A tiny mock of racecenter.letour.fr for end-to-end testing.

Serves:
  /api/allCompetitors-2026, /api/team-2026, /api/stage-2026
  /profils/2026/profile-14-abc.csv
  /live-stream  (SSE: telemetryCompetitor-2026, pack-2026, and a commentary
                 bind the parser has never seen — to prove raw capture works)

Run: python tests/mock_racecenter.py [port]
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

YEAR = 2026


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == f"/api/allCompetitors-{YEAR}":
            self._json([{"Bib": 1, "lastname": "POGACAR"}, {"Bib": 51, "lastname": "VINGEGAARD"}])
        elif self.path == f"/api/team-{YEAR}":
            self._json([{"id": "uae", "name": "UAE Team Emirates"}])
        elif self.path == f"/api/stage-{YEAR}":
            self._json([{"stage": 14, "date": "2026-07-18",
                         "profile": f"/profils/{YEAR}/profile-14-abc.csv", "length": 182.5}])
        elif self.path.startswith("/profils/"):
            body = b"lat,lon,altitude,km\n45.1,6.1,1200,0.0\n45.2,6.2,1850,1.0\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/en/":
            body = f'<html><a href="/profils/{YEAR}/profile-14-abc.csv">p</a></html>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/live-stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                for tick in range(12):
                    telemetry = {
                        "bind": f"telemetryCompetitor-{YEAR}",
                        "data": {"TimeStamp": 1000 + tick, "Riders": [
                            {"Bib": 1, "Latitude": 45.1 + tick / 1000,
                             "Longitude": 6.1, "CurrentSpeed": 41.5 + tick},
                            {"Bib": 51, "Latitude": 45.1, "Longitude": 6.09,
                             "CurrentSpeed": 40.9},
                        ]},
                    }
                    pack = {
                        "bind": f"pack-{YEAR}",
                        "data": {"groups": [
                            {"bibs": [{"bib": 1}], "remainingDistance": 42000 - tick * 100,
                             "relative": 0},
                            {"bibs": [{"bib": 51}], "remainingDistance": 42150 - tick * 100,
                             "relative": 15},
                        ]},
                    }
                    commentary = {
                        "bind": f"liveFeed-{YEAR}",
                        "data": [{"text": f"Attack at km {100 + tick}!",
                                  "type": "attack", "km": 100 + tick}],
                    }
                    for msg in (telemetry, pack, commentary):
                        self.wfile.write(
                            f"event: update\ndata: {json.dumps(msg)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.3)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif "/race/tour-de-france/" in self.path:
            # PCS-style archived stage page with a timeline
            body = b"""<html><body>
            <div>Start 12/07 14:00</div>
            <ul class="timeline">
              <li><span>P</span> Welcome at the preview feed for Stage 9.</li>
              <li><span>27m</span> The neutralized start is scheduled at 13:35.</li>
              <li><span>-3.2</span> The riders roll out of Malemort.</li>
              <li><span>171</span> Attack! Five riders clip off the front.</li>
              <li><span>144.5</span> The gap grows to 2:40 for the breakaway.</li>
              <li><span>80</span> Crash in the peloton, all riders back up.</li>
              <li><span>0.4</span> Sprint opens up on the finishing straight!</li>
              <li><span>F</span> Stage win decided; GC unchanged.</li>
              <li><a href="/race/x">Startlist</a></li>
            </ul></body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/en/stage-"):
            body = b"<html><body>Official letour stage page ticker</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"mock racecenter on :{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
