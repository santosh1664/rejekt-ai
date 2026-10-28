"""
ml/classifier-server.py

A tiny HTTP server (stdlib only — no Flask/FastAPI needed) that loads
the model once and serves POST /classify requests. Node.js hits this
instead of spawning a new process per job (much faster for bulk).

Usage:
  set -a && source .env.local && set +a && python3 ml/classifier-server.py
"""
import json, joblib, os
from http.server import HTTPServer, BaseHTTPRequestHandler

model_path = os.path.join(os.path.dirname(__file__), 'model.joblib')
print(f'Loading model from {model_path}...')
MODEL = joblib.load(model_path)
print('Model ready.')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass  # silence request logs

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = json.loads(self.rfile.read(length))
        title  = body.get('title', '')
        desc   = body.get('description', '')[:400]
        text   = f"{title} {title} {title} {desc}"
        cat    = MODEL.predict([text])[0]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'category': cat}).encode())

PORT = int(os.environ.get('ML_PORT', 5001))
print(f'ML classifier server on http://localhost:{PORT}')
HTTPServer(('', PORT), Handler).serve_forever()
