"""Local Hebrew neural text-to-speech for ClaudeBot voice chat (Phonikud diacritics + Piper voice, CPU).
Listens on a private unix socket; POST / {"text": "...", "rate": 1.0} -> audio/wav. Nothing leaves this machine."""
import io, json, os, re, socket, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn, UnixStreamServer
from phonikud_onnx import Phonikud
from phonikud import phonemize
from piper_onnx import Piper
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SOCK = sys.argv[1]
phonikud = Phonikud(os.path.join(HERE, 'models/phonikud-1.0.int8.onnx'))
piper = Piper(os.path.join(HERE, 'models/shaul.onnx'), os.path.join(HERE, 'models/model.config.json'))
lock = threading.Lock()

def synth(text, rate):
    text = re.sub(r'\s+', ' ', text).strip()[:1200]
    with lock:
        phonemes = phonemize(phonikud.add_diacritics(text))
        samples, sr = piper.create(phonemes, is_phonemes=True, length_scale=1.0 / max(0.6, min(2.0, rate)))
    buf = io.BytesIO(); sf.write(buf, samples, sr, format='WAV', subtype='PCM_16')
    return buf.getvalue()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def address_string(self): return 'local'
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
            wav = synth(str(body.get('text', '')), float(body.get('rate') or 1))
            self.send_response(200); self.send_header('content-type', 'audio/wav'); self.send_header('content-length', str(len(wav))); self.end_headers(); self.wfile.write(wav)
        except Exception as e:
            msg = str(e).encode(); self.send_response(500); self.send_header('content-length', str(len(msg))); self.end_headers(); self.wfile.write(msg)

class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True
    def get_request(self):
        r, _ = super().get_request(); return r, ('local', 0)

try: os.unlink(SOCK)
except FileNotFoundError: pass
old = os.umask(0o177); srv = Server(SOCK, H); os.umask(old)
synth('שלום', 1.0)  # warm up
print('tts ready', flush=True)
srv.serve_forever()
