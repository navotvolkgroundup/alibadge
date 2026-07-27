# Serves the labelled set to the extension worker and receives harvested verdicts.
#
# The worker fetches _items.json and POSTs progress to /harvest after every item, so
# a rate-punish partway through keeps everything measured up to that point.
# CORS is wide open because the only client is a local extension worker.
import http.server, socketserver, json, pathlib

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n)
        try:
            rows = json.loads(body)
        except Exception:
            self.send_response(400); self.end_headers(); return
        pathlib.Path('harvest.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False))
        print(f'harvest: {len(rows)} items')
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')

socketserver.TCPServer.allow_reuse_address = True
print('labelset server on http://127.0.0.1:8899  (_items.json out, /harvest in)')
socketserver.TCPServer(('127.0.0.1', 8899), H).serve_forever()
