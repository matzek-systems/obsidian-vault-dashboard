#!/usr/bin/env python3
"""Remote App phase 0: the live thread board as an installable PWA with web push.

Front door is `tailscale serve --bg 8378` (HTTPS, tailnet-only, real cert), which
proxies to 127.0.0.1:8378 -- so this binds loopback (or a 100.x tailnet IP), never
0.0.0.0 / LAN.

  GET  /                   the board, phone-native (phone_render.home) from live dashboard-data.json
  GET  /seats /seat/<n> /pane/<leaf> /thread/<id> /wi/<id> /processes /setup
  GET  /shell              the app shell: "Connecting…" screen with a step bar. The service worker
                           answers every navigation with this shell when the network hasn't replied
                           within SW_RACE_MS (or errors / gateways 5xx), so a cold launch over a
                           sleeping tunnel shows progress instead of a blank page; the shell then
                           fetches the real page and swaps it in (session 942).
  GET  /status.json        server + Tailscale front door + push relay (launch.status())
  POST /restart            relaunch this server via launch.py --restart (after code edits)
  GET  /manifest.webmanifest, /sw.js, /icon-<size>.png
  GET  /vapid-public       VAPID public key (base64url) for pushManager.subscribe
  POST /subscribe          store one push subscription
  GET  /push-test          send a test push to every stored subscription
  GET  /data, /health, /attention

Secrets (VAPID private key) and device subscriptions live OUTSIDE the vault:
%LOCALAPPDATA%\\vault-remote\\  (DL-374).
Lifecycle: launch.py beside this file (--ensure / --restart / --stop / --status); the vault-dashboard
plugin runs it on load/unload. Detached pythonw, PID in serve.pid; a detached process never reloads
code, so edit -> `launch.py --restart`. The vault is VAULT_PATH or found by walking up (vaultpath.py).
"""
import argparse
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import vaultpath
import phone_render   # sibling module: phone-native pages from the same JSON
import seat_bridge
import voice    # sibling module: focus / send / keys / screen on a desk pane via `obsidian eval`
import feed           # sibling module: transcript -> chat turns with a byte cursor
import launch         # sibling module: lifecycle + front-door/push status (shared with the CLI + dashboard)

sys.path.insert(0, str(vaultpath.DASHBOARD))
try:
    import seat_state as _seat_state_mod
except Exception:
    _seat_state_mod = None


def _jsonl_for(n) -> str | None:
    try:
        return dict(_seat_state_mod._live_seats()).get(int(n)) if _seat_state_mod else None
    except Exception:
        return None

sys.path.insert(0, str(vaultpath.TOOLS))
try:
    from win_console import suppress_child_windows   # DL-457: no console per git/node child under pythonw
    suppress_child_windows()
except Exception:
    pass

HERE = Path(__file__).resolve().parent
CLAUDE_DIR = vaultpath.CLAUDE_DIR
GEN = vaultpath.DASHBOARD / "dashboard_data.py"
DATA = vaultpath.STATE / "dashboard-data.json"
PROC = vaultpath.STATE / "process-status.json"
UPLOAD_DIR = vaultpath.VAULT / "01_Inbox/phone-uploads"   # s931: photos from the phone land here (Obsidian-synced)
HTML = "text/html; charset=utf-8"
# The desk-density board preview (/desk) is built by the plugin SOURCE repo's tools/render-preview.mjs
# (esbuild over src/render). Present in a dev clone, absent in an installed plugin: /desk degrades.
_RENDER_CAND = HERE.parent / "tools" / "render-preview.mjs"
RENDER = _RENDER_CAND if _RENDER_CAND.exists() else None
INDEX = HERE / "index.html"
STATE_DIR = vaultpath.STATE_DIR
VAPID_PEM = STATE_DIR / "vapid_private.pem"
SUBS = STATE_DIR / "subscriptions.json"
PUSHED = STATE_DIR / "pushed.json"        # attention keys already pushed (or seen on the desk)
PREFS = STATE_DIR / "notify-prefs.json"   # {"level": off|questions|all, "cooldown_min": N} -- operator-set in Settings
SEATLAST = STATE_DIR / "push-seats.json"  # {seat: last_push_epoch} -- per-seat cooldown so one chatty seat can't spam
HOST = (socket.gethostname() or "the desk").split(".")[0].lower()   # shown in the connecting shell
LAUNCHER_HINT = vaultpath.launcher_rel()
STALE_S = 45
WIDTH = 420
POLL_S = 15          # watcher cadence: stat the watched files, never regenerate on the clock
REGEN_GAP_S = 20     # same debounce as the panel; also skips a regen the panel just did
QUIET_MIN = 2        # operator typed into a seat this recently = at the desk, saw artifacts land
MAX_BURST = 4        # more new rows than this in one cycle -> one summary push
_last = 0.0

# ---------------------------------------------------------------- render

def refresh():
    global _last
    if time.time() - _last < STALE_S and INDEX.exists():
        return
    try:
        subprocess.run([sys.executable, str(GEN)], capture_output=True, timeout=150)
        if RENDER:
            subprocess.run(["node", str(RENDER), str(DATA), str(INDEX), "--width", str(WIDTH)],
                           capture_output=True, timeout=60, shell=(sys.platform == "win32"))
    except Exception:
        pass
    _last = time.time()


def origin() -> str:
    """The app's public origin (the tailnet HTTPS front door), for VAPID claims; a mailto when
    Tailscale is not up yet (the spec allows either)."""
    try:
        u = launch.front_url(remote_status().get("tailscale"))
    except Exception:
        u = ""
    return u or "mailto:vault-remote@localhost"


PWA_HEAD = """
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Vault">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="theme-color" content="#0c0c0c">
<style>body{padding-bottom:72px}
#ra-bar{position:fixed;bottom:0;left:0;right:0;padding:10px 14px;background:#141414;color:#d4d4d4;border-top:1px solid #232323;
 font:14px -apple-system,system-ui,sans-serif;display:flex;gap:10px;align-items:center;z-index:9999;flex-wrap:wrap}
#ra-bar button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #6a9bd0;background:#5a8ec7;color:#fff}
#ra-bar #ra-status{flex:1 1 100%;opacity:.9}
#ra-note{background:#c08a4a;color:#0c0c0c;padding:8px 14px;font:14px -apple-system,system-ui,sans-serif}</style>
"""

PWA_BAR = """
<div id="ra-bar"><span id="ra-status">push: checking</span>
<button id="ra-enable">Enable push</button><button id="ra-test">Send test push</button></div>
<script>
(async function(){
  const st=document.getElementById('ra-status'),en=document.getElementById('ra-enable'),te=document.getElementById('ra-test');
  const standalone=(window.navigator.standalone===true)||matchMedia('(display-mode: standalone)').matches;
  if(!('serviceWorker' in navigator)){st.textContent='push: no service worker here (needs https)';return;}
  let reg;
  try{reg=await navigator.serviceWorker.register('/sw.js');}catch(e){st.textContent='push: sw failed '+e;return;}
  if(!('PushManager' in window)){
    st.textContent=standalone?'push: unsupported in this shell':'push: add to Home Screen first (Share, Add to Home Screen), then open from the icon';
    return;}
  async function show(){const s=await reg.pushManager.getSubscription();
    st.textContent=s?'push: ON for this phone':(standalone?'push: off, tap Enable':'push: open from the Home Screen icon, then Enable');}
  await show();
  en.onclick=async()=>{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){st.textContent='push: permission '+perm;return;}
    const key=await (await fetch('/vapid-public')).text();
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(key)});
    const r=await fetch('/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
    st.textContent='push: subscribed ('+await r.text()+')';await show();};
  te.onclick=async()=>{const r=await fetch('/push-test');st.textContent='push: test sent, '+await r.text();};
  function b64(s){const p='='.repeat((4-s.length%4)%4);const b=atob((s+p).replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(b,c=>c.charCodeAt(0));}
})();
</script>
"""

SW_RACE_MS = 1500     # a navigation that hasn't answered by then gets the shell (the tunnel is waking up)

# App shell (session 942). Served at /shell and cached by the worker at install. Every phone launch
# used to be a blank page for as long as iOS took to wake the Tailscale tunnel (or forever, when the
# desk was down); the shell shows which step it is on and why it's stuck, then fetches the real page
# and writes it into the document (no reload loop: the swap is a fetch, not a navigation).
SHELL_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0c0c0c">
<title>Vault</title>
<style>
:root{--ground:#0c0c0c;--ink:#d4d4d4;--ink2:#8a8a8a;--line:#232323;--accent:#5a8ec7;--bad:#c77e7e;--chip:#1a1a1a}
html{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--ground);color:var(--ink);font:17px/1.4 -apple-system,"SF Pro Text",system-ui,sans-serif;padding:24px}
.box{width:100%;max-width:360px}
.logo{width:58px;height:58px;border-radius:15px;background:var(--accent);color:#fff;font-weight:800;font-size:29px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.93);opacity:.7}}
h1{font-size:21px;margin:0 0 3px;text-align:center}
.sub{color:var(--ink2);font-size:15px;text-align:center;min-height:22px}
.bar{height:8px;border-radius:4px;background:var(--chip);overflow:hidden;margin:18px 0 14px}
.bar i{display:block;height:100%;width:6%;background:var(--accent);border-radius:4px;transition:width .5s ease}
.bar.wait i{background-image:linear-gradient(90deg,rgba(255,255,255,0) 0,rgba(255,255,255,.4) 50%,rgba(255,255,255,0) 100%);background-size:200% 100%;animation:sh 1.1s linear infinite}
@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}
.steps{list-style:none;margin:0;padding:0;font-size:15px}
.steps li{display:flex;gap:10px;align-items:center;padding:6px 0;color:var(--ink2)}
.steps li::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid var(--line);flex:0 0 auto}
.steps li.on{color:var(--ink);font-weight:600}
.steps li.on::before,.steps li.ok::before{border-color:var(--accent);background:var(--accent)}
.steps li.bad{color:var(--bad)}.steps li.bad::before{border-color:var(--bad);background:var(--bad)}
.hint{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--chip);font-size:15px;display:none}
.hint.on{display:block}.hint b{display:block;margin-bottom:2px}
.meta{margin-top:14px;display:flex;gap:10px;align-items:center;color:var(--ink2);font-size:13px;font-variant-numeric:tabular-nums}
.meta button{margin-left:auto;font:600 14px -apple-system,system-ui,sans-serif;padding:8px 12px;border-radius:9px;border:1px solid var(--line);background:var(--chip);color:var(--ink)}
</style></head><body><div class="box">
<div class="logo">V</div><h1>Vault</h1><div class="sub" id="sub">Connecting</div>
<div class="bar wait" id="bar"><i id="fill"></i></div>
<ol class="steps"><li id="s1">Reaching @HOST@ over Tailscale</li><li id="s2">Loading <span id="pg">the board</span></li><li id="s3">Rendering</li></ol>
<div class="hint" id="hint"></div>
<div class="meta"><span id="try"></span><span id="clock">0s</span><button id="retry" type="button">Retry now</button></div>
</div>
<script>
(function(){
  var pn=location.pathname==='/shell'?'/':location.pathname;   /* a direct /shell visit means the board */
  var path=pn+location.search, t0=Date.now(), n=0, timer=null;
  if(pn!==location.pathname){try{history.replaceState(null,'',path);}catch(e){}}
  var $=function(i){return document.getElementById(i);};
  var names={'/':'the board','/seats':'seats','/processes':'processes','/setup':'settings','/desk':'the desk board'};
  var pg=names[pn];
  if(!pg){pg=pn.indexOf('/seat/')===0?'seat '+pn.split('/')[2]:pn.indexOf('/pane/')===0?'the pane':pn.indexOf('/thread/')===0?'the thread':pn.indexOf('/wi/')===0?decodeURIComponent(pn.slice(4)):'the page';}
  $('pg').textContent=pg;
  function step(i,state){for(var k=1;k<=3;k++){$('s'+k).className=k<i?'ok':(k===i?(state||'on'):'');}}
  function fill(p,wait){$('fill').style.width=p+'%';$('bar').className='bar'+(wait?' wait':'');}
  function hint(t,b){var el=$('hint');if(!t){el.className='hint';el.innerHTML='';return;}el.className='hint on';el.innerHTML='<b>'+b+'</b>'+t;}
  setInterval(function(){$('clock').textContent=Math.round((Date.now()-t0)/1000)+'s';},1000);
  function get(u,ms){var c=new AbortController();var id=setTimeout(function(){c.abort();},ms);
    return fetch(u,{signal:c.signal,cache:'no-store'}).then(function(r){clearTimeout(id);return r;},function(e){clearTimeout(id);throw e;});}
  function attempt(){
    n++;timer=null;$('try').textContent='try '+n;$('sub').textContent='Connecting';hint('');
    step(1);fill(12,true);
    get('/health',4000).then(function(r){
      if(r.status>=500){throw {gw:r.status};}
      if(!r.ok){throw {http:r.status};}
      step(2);fill(48,true);$('sub').textContent='@HOST@ answered';
      return get(path,30000);
    }).then(function(r){
      if(!r.ok){throw {http:r.status};}
      return r.text();
    }).then(function(html){
      step(3);fill(94,false);$('sub').textContent='Rendering';
      setTimeout(function(){
        try{document.open();document.write(html);document.close();}
        catch(e){location.replace(path);}
      },150);
    }).catch(function(e){
      var wait=Math.min(6000,900+n*700);
      if(e&&e.gw){step(1,'bad');$('sub').textContent='Server not running';
        hint('Tailscale reached @HOST@, but the app server is down. On the desk: Processes, remote-app, Launch. Or from a shell: python @LAUNCHER@ --ensure','Gateway '+e.gw);}
      else if(e&&e.http){step(2,'bad');$('sub').textContent='@HOST@ answered '+e.http;hint('Retrying.','HTTP '+e.http);}
      else{step(1,'bad');$('sub').textContent="Can't reach @HOST@";
        hint(n>=2?'Is Tailscale on for this phone? If it is, Tailscale on the desk may be down: the tray app has to be running (or Run unattended enabled).':'Waiting for the tunnel to wake up.','No route');}
      fill(6,true);timer=setTimeout(attempt,wait);
    });
  }
  $('retry').onclick=function(){if(timer){clearTimeout(timer);}attempt();};
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&timer){clearTimeout(timer);attempt();}});
  attempt();
})();
</script></body></html>
""".replace("@HOST@", HOST).replace("@LAUNCHER@", LAUNCHER_HINT)

# Cache key = hash of the shell: any shell edit re-installs the worker on every phone at its next
# open, so no phone keeps serving a stale cached shell.
SW_VERSION = "s948-" + hashlib.sha1(SHELL_HTML.encode("utf-8")).hexdigest()[:8]

SW_JS = """
var V='%(v)s', CACHE='vault-shell-'+V, SHELL='/shell', RACE=%(race)d;
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.add(new Request(SHELL,{cache:'reload'}))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.mode!=='navigate'||r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin!==self.location.origin||u.pathname===SHELL)return;
  e.respondWith((async()=>{
    const shell=async()=>(await caches.match(SHELL))||fetch(r);
    let t;const timeout=new Promise(res=>{t=setTimeout(()=>res('timeout'),RACE);});
    try{
      const w=await Promise.race([fetch(r),timeout]);
      clearTimeout(t);
      if(w==='timeout')return shell();
      if(w.status>=500)return shell();
      return w;
    }catch(_){clearTimeout(t);return shell();}
  })());
});
self.addEventListener('push',e=>{
  let d={};try{d=e.data.json();}catch(_){d={body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'Vault',{body:d.body||'',tag:d.tag||undefined,data:{url:d.url||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL(e.notification.data&&e.notification.data.url||'/',self.location.origin).href;
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
    for(const w of ws){if('navigate' in w){return w.navigate(url).then(x=>x&&x.focus());}}
    return clients.openWindow(url);}));
});
""" % {"v": SW_VERSION, "race": SW_RACE_MS}

MANIFEST = {
    "name": "Vault", "short_name": "Vault", "start_url": "/", "scope": "/", "display": "standalone",
    "background_color": "#0c0c0c", "theme_color": "#0c0c0c",
    "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}],
}


ANSWER_LOG = Path(os.environ.get("LOCALAPPDATA", ".")) / "vault-remote" / "answers.log"


def _log_answer(handle: str, ks: list, ok: bool, msg: str) -> None:
    """s942: record what a tapped answer did to the pane (the keys, then the screen ~1.2 s later)
    so the question-TUI key sequence can be checked after the fact. Local file, never served."""
    def run():
        time.sleep(1.2)
        sok, scr = seat_bridge.screen(handle, 40)
        try:
            ANSWER_LOG.parent.mkdir(parents=True, exist_ok=True)
            with ANSWER_LOG.open("a", encoding="utf-8") as f:
                f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {handle} keys={ks} ok={ok} msg={msg}\n"
                        f"{scr if sok else 'screen: ' + str(scr)}\n")
        except OSError:
            pass
    threading.Thread(target=run, daemon=True).start()


VOICE_TEST_BODY = """
<div class="band"><h2>Voice capability test</h2><div class="card" style="padding:12px 14px">
<div id="vt" style="font-size:15px;line-height:1.55"></div>
<div class="acts" style="padding:12px 0 0;border:0;flex-wrap:wrap;gap:8px">
<button type="button" class="btn" id="rec">Record 3 s</button>
<button type="button" class="btn alt" id="spk">Speak a line</button>
<button type="button" class="btn alt" id="sr">Web speech recognition</button>
</div>
<div id="vo" style="font-size:15px;color:var(--ink2);margin-top:10px;min-height:22px"></div>
<div style="font-size:13px;color:var(--ink2);margin-top:10px">Nothing here is uploaded: the recording plays back on the phone and is dropped.</div>
</div></div>
<script>
(function(){
 var vt=document.getElementById('vt'), vo=document.getElementById('vo');
 function row(k,v){var d=document.createElement('div');d.innerHTML='<b>'+k+'</b> '+v;vt.appendChild(d);}
 function say(t){vo.textContent=t;}
 var md=navigator.mediaDevices;
 row('home-screen app', String(!!navigator.standalone));
 row('getUserMedia', String(!!(md&&md.getUserMedia)));
 row('MediaRecorder', String(!!window.MediaRecorder));
 if(window.MediaRecorder){['audio/mp4','audio/webm','audio/webm;codecs=opus','audio/aac','audio/wav'].forEach(function(t){row('&nbsp;&nbsp;'+t, String(MediaRecorder.isTypeSupported(t)));});}
 row('speechSynthesis', String(!!window.speechSynthesis)+(window.speechSynthesis?(' · '+speechSynthesis.getVoices().length+' voices'):''));
 row('SpeechRecognition', String(!!(window.SpeechRecognition||window.webkitSpeechRecognition)));
 row('user agent', navigator.userAgent.slice(0,100));
 document.getElementById('rec').onclick=function(){
  if(!(md&&md.getUserMedia&&window.MediaRecorder)){say('recording is not available here');return;}
  say('asking for the mic…');
  md.getUserMedia({audio:true}).then(function(st){
    var mr=new MediaRecorder(st), chunks=[]; mr.ondataavailable=function(e){chunks.push(e.data);};
    mr.onstop=function(){st.getTracks().forEach(function(t){t.stop();});var b=new Blob(chunks,{type:mr.mimeType});
      say('recorded '+b.size+' bytes as '+(mr.mimeType||'(no type)')+' · playing back');
      var a=new Audio(URL.createObjectURL(b)); a.onended=function(){say('recorded '+b.size+' bytes as '+(mr.mimeType||'(no type)')+' · played back OK');};
      a.play().catch(function(e){say('recorded '+b.size+' bytes as '+(mr.mimeType||'(no type)')+' · playback blocked: '+e.message);});};
    mr.start(); say('recording 3 s… talk'); setTimeout(function(){mr.stop();},3000);
  }).catch(function(e){say('mic refused: '+e.name+' '+e.message);});
 };
 document.getElementById('spk').onclick=function(){
  if(!window.speechSynthesis){say('no speechSynthesis');return;}
  var u=new SpeechSynthesisUtterance('Seat nine forty two is waiting for you. The phone can speak replies.');
  u.onend=function(){say('spoke it');}; u.onerror=function(e){say('speak error: '+e.error);};
  speechSynthesis.cancel(); speechSynthesis.speak(u); say('speaking…');
 };
 document.getElementById('sr').onclick=function(){
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){say('no SpeechRecognition');return;}
  var r=new SR(); r.lang='en-US'; r.interimResults=false;
  r.onresult=function(e){say('heard: '+e.results[0][0].transcript);}; r.onerror=function(e){say('recognition error: '+e.error);};
  try{r.start(); say('listening (this one goes through Apple)… say something');}catch(e){say('start failed: '+e.message);}
 };
})();
</script>"""


def page(note: str = "") -> bytes:
    refresh()
    html = INDEX.read_text(encoding="utf-8") if INDEX.exists() else "<html><head></head><body>no render yet</body></html>"
    html = html.replace("<head>", "<head>" + PWA_HEAD, 1) if "<head>" in html else PWA_HEAD + html
    bar = (f'<div id="ra-note">{note}</div>' if note else "") + PWA_BAR
    html = html.replace("</body>", bar + "</body>", 1) if "</body>" in html else html + bar
    return html.encode("utf-8")


def icon(size: int) -> bytes:
    p = HERE / f"icon-{size}.png"
    if not p.exists():
        from PIL import Image, ImageDraw, ImageFont
        im = Image.new("RGB", (size, size), "#0c0c0c")
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([size * 0.12, size * 0.12, size * 0.88, size * 0.88], radius=size * 0.16, fill="#5a8ec7")
        try:
            f = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", int(size * 0.5))
            d.text((size / 2, size / 2), "V", fill="white", font=f, anchor="mm")
        except Exception:
            pass
        im.save(p)
    return p.read_bytes()

# ---------------------------------------------------------------- push

def _vapid():
    from py_vapid import Vapid
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not VAPID_PEM.exists():
        v = Vapid()
        v.generate_keys()
        v.save_key(str(VAPID_PEM))
    return Vapid.from_file(str(VAPID_PEM))


def vapid_public_b64() -> str:
    from cryptography.hazmat.primitives import serialization
    raw = _vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _subs() -> list:
    try:
        return json.loads(SUBS.read_text(encoding="utf-8"))
    except Exception:
        return []


def add_sub(sub: dict) -> int:
    subs = [s for s in _subs() if s.get("endpoint") != sub.get("endpoint")] + [sub]
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SUBS.write_text(json.dumps(subs), encoding="utf-8")
    return len(subs)


def send_push(title: str, body: str, url: str = "/", tag: str = "") -> str:
    from pywebpush import webpush, WebPushException
    _vapid()
    subs, keep, ok, bad = _subs(), [], 0, []
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    for s in subs:
        try:
            webpush(subscription_info=s, data=payload, vapid_private_key=str(VAPID_PEM),
                    vapid_claims={"sub": origin()}, ttl=600)
            ok += 1
            keep.append(s)
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code in (404, 410):
                bad.append(code)          # gone: drop it
            else:
                bad.append(code or str(e)[:60])
                keep.append(s)
        except Exception as e:
            bad.append(str(e)[:60])
            keep.append(s)
    SUBS.write_text(json.dumps(keep), encoding="utf-8")
    return f"sent {ok}/{len(subs)}" + (f", failed {bad}" if bad else "")

# ---------------------------------------------------------------- attention -> push (phase 1)

_push_log: list = []
_regen_at = 0.0


def _key(r: dict) -> str:
    h = hashlib.sha1((r.get("text") or "").encode("utf-8", "replace")).hexdigest()[:12]
    if r.get("kind") == "rule":
        return f"r:{r.get('label')}"                    # an overdue WI nags once, not daily
    return f"{(r.get('kind') or '?')[:1]}:{r.get('seat')}:{h}"


def _load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _maybe_regen(d: dict):
    """Regenerate when a watched file (registry, ledger, a live seat's JSONL) moved
    after the JSON was written and the panel hasn't already caught it."""
    global _regen_at
    try:
        data_m = DATA.stat().st_mtime
        newest = max((os.path.getmtime(w) for w in d.get("watch") or [] if os.path.exists(w)), default=0)
    except Exception:
        return
    if newest > data_m + REGEN_GAP_S and time.time() - _regen_at > REGEN_GAP_S:
        _regen_at = time.time()
        try:
            subprocess.run([sys.executable, str(GEN)], capture_output=True, timeout=150)
        except Exception:
            pass


def _title(r: dict) -> str:
    label = r.get("label") or (f"seat {r.get('seat')}" if r.get("seat") else "Vault")
    return {"question": f"{label} asks", "artifact": f"{label} finished",
            "rule": f"Overdue: {label}", "handoff": f"Handoff: {label}"}.get(r.get("kind"), label)


# What each notify level pushes. "away" = a seat is waiting on the operator AND they aren't
# actively in that seat (the every-turn "waiting on user" is a Seats-screen display, never a
# push while they're working it); "all" adds finished artifacts + overdue-WI nags. Default "away".
PUSH_KINDS = {"away": {"question", "handoff"},
              "all": {"question", "artifact", "handoff", "rule"}}


def _prefs() -> tuple:
    p = _load_json(PREFS, {}) or {}
    lvl = p.get("level", "away")
    if lvl == "questions":                  # migrate the earlier label
        lvl = "away"
    if lvl not in ("off", "away", "all"):
        lvl = "away"
    try:
        cd = float(p.get("cooldown_min", 20))
    except Exception:
        cd = 20.0
    return lvl, max(0.0, cd)


def _flush_pushed(seen: dict, now: float):
    cutoff = now - 14 * 86400
    PUSHED.write_text(json.dumps({k: v for k, v in seen.items() if v > cutoff}), encoding="utf-8")
    del _push_log[:-50]


def attention_cycle():
    d = _load_json(DATA, {})
    _maybe_regen(d)
    d = _load_json(DATA, d)
    rows = d.get("attention") or []
    seen = _load_json(PUSHED, None)
    now = time.time()
    if seen is None:                       # first run: what is already on the desk is old news
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        PUSHED.write_text(json.dumps({_key(r): now for r in rows}), encoding="utf-8")
        return
    level, cooldown_min = _prefs()
    if level == "off":                     # muted: keep the seen set current so re-enabling won't burst old rows
        for r in rows:
            seen.setdefault(_key(r), now)
        _flush_pushed(seen, now)
        return
    allowed = PUSH_KINDS[level]
    seat_last = _load_json(SEATLAST, {}) or {}
    # per-seat operator recency: minutes since they last typed into each seat (None = never)
    seat_user_min = {str(s.get("n")): s.get("user_min")
                     for s in d.get("sessions") or [] if s.get("n") is not None}
    at_desk = any((v if v is not None else 999) <= QUIET_MIN for v in seat_user_min.values())
    to_push = []
    for r in rows:
        k = _key(r)
        if k in seen:
            continue
        if r.get("kind") not in allowed:
            seen[k] = now                  # not a notifying kind at this level; mark seen so a later level change won't replay it
            continue
        if r.get("kind") == "artifact" and at_desk:
            seen[k] = now                  # they were typing when it landed; no push
            continue
        seat = str(r.get("seat") or "")
        if seat:
            um = seat_user_min.get(seat)
            if um is not None and um < cooldown_min:
                seen[k] = now              # they're actively in this seat -> it's a Seats-screen display, not a push
                continue
            if (now - seat_last.get(seat, 0)) < cooldown_min * 60:
                seen[k] = now              # already pinged about this seat within the quiet window
                continue
        to_push.append(r)
    if len(to_push) > MAX_BURST:
        res = send_push("Vault", f"{len(to_push)} things need you", "/", "burst")
        _push_log.append({"t": now, "title": f"burst x{len(to_push)}", "res": res})
    else:
        for r in to_push:
            url = f"/seat/{r['seat']}" if r.get("seat") else "/"
            res = send_push(_title(r), (r.get("text") or "")[:160], url, _key(r))
            _push_log.append({"t": now, "title": _title(r), "res": res})
    for r in to_push:
        seen[_key(r)] = now
        seat = str(r.get("seat") or "")
        if seat:
            seat_last[seat] = now
    SEATLAST.write_text(json.dumps(seat_last), encoding="utf-8")
    _flush_pushed(seen, now)


def watcher():
    while True:
        try:
            attention_cycle()
        except Exception as e:
            _push_log.append({"t": time.time(), "error": str(e)[:160]})
        time.sleep(POLL_S)

# ---------------------------------------------------------------- self status (session 942)

_STARTED = time.time()
_status_cache: tuple = (0.0, {})
STATUS_TTL_S = 20     # tailscale status/serve are two subprocess calls; the Processes page polls this


def remote_status() -> dict:
    """This server + the Tailscale front door + the push relay, for /status.json and the
    Processes page. Cached STATUS_TTL_S so a phone refresh loop can't hammer tailscale.exe."""
    global _status_cache
    if time.time() - _status_cache[0] < STATUS_TTL_S:
        return _status_cache[1]
    try:
        ts = launch.tailscale_status()
    except Exception as e:
        ts = {"backend": f"probe failed: {e.__class__.__name__}", "online": False, "dns": "", "ip": "",
              "serve": False, "serve_text": "", "gui": False, "health": []}
    lvl, cd = _prefs()
    last = next((x for x in reversed(_push_log) if x.get("title")), None)
    out = {"ok": True, "pid": os.getpid(), "started": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(_STARTED)),
           "uptime_s": int(time.time() - _STARTED), "port": launch.PORT, "url": launch.front_url(ts),
           "vault": str(vaultpath.VAULT), "server": str(Path(__file__).resolve()),
           "tailscale": ts,
           "push": {"devices": len(_subs()), "level": lvl, "cooldown_min": int(cd),
                    "last": (time.strftime("%H:%M", time.localtime(last["t"])) + " " + last["title"]) if last else ""},
           "data_generated": (_load_json(DATA, {}) or {}).get("generated"),
           "checked": time.strftime("%H:%M:%S")}
    _status_cache = (time.time(), out)
    return out


def _restart_self():
    """Spawn `launch.py --restart` detached and let it stop this process. Called off a timer so
    the /restart response has already gone out."""
    kwargs: dict = {"close_fds": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([launch._bg_python(), str(HERE / "launch.py"), "--restart"],
                     cwd=str(HERE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)

# ---------------------------------------------------------------- http

def _panes():
    """Desk panes with the seat number joined in (the renderer partitions live seats on it)."""
    try:
        panes = seat_bridge.desk_panes()
    except Exception:
        return []
    nums = seat_bridge.seat_numbers()
    return [dict(x, n=nums.get(x.get("uuid") or "")) for x in panes]


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?", 1)[0]
        head = PWA_HEAD.encode()
        if p in ("/", "/index.html"):
            # s948: the board's Seats band is the same partition as /seats, so it needs the panes too
            self._send(head + phone_render.page("home", _load_json(DATA, {}), panes=_panes()), HTML)
        elif p == "/desk":
            self._send(page(), HTML)                      # the desk-density Obsidian render
        elif p == "/desk-seats":
            self._send(json.dumps(seat_bridge.desk_seats()).encode(), "application/json")
        elif p == "/desk-seat-ns":                      # seat NUMBERS attached to a desk pane
            nums = seat_bridge.seat_numbers()
            self._send(json.dumps(sorted({str(nums[u]) for u in seat_bridge.desk_seats() if u in nums})).encode(), "application/json")
        elif p == "/desk-panes":
            self._send(json.dumps(seat_bridge.desk_panes()).encode(), "application/json")
        elif re.match(r"^/seat/\d+/feed$", p):
            n = p.split("/")[2]
            jp = _jsonl_for(n)
            if not jp:
                self._send(json.dumps({"entries": [], "offset": 0, "size": 0, "state": None, "detail": "no transcript"}).encode(), "application/json")
                return
            q = dict(x.split("=", 1) for x in self.path.split("?", 1)[1].split("&") if "=" in x) if "?" in self.path else {}
            since = int(q["since"]) if q.get("since", "").isdigit() else None
            try:
                out = feed.read(jp, since)
            except Exception as e:
                out = {"entries": [], "offset": since or 0, "size": 0, "error": e.__class__.__name__}
            try:
                st = _seat_state_mod.seat_state(jp) if _seat_state_mod else {}
            except Exception:
                st = {}
            out["state"], out["detail"] = st.get("state"), st.get("detail")
            self._send(json.dumps(out).encode(), "application/json; charset=utf-8")
        elif re.match(r"^/pane/[0-9a-f]{8,32}/screen$", p):
            ok, txt = seat_bridge.screen("leaf:" + p.split("/")[2])
            self._send((txt if ok else f"[{txt}]").encode("utf-8"), "text/plain; charset=utf-8")
        elif re.match(r"^/pane/[0-9a-f]{8,32}$", p):
            leaf = p.split("/")[2]
            info = next((x for x in seat_bridge.desk_panes() if x.get("leaf") == leaf), None)
            self._send(head + phone_render.page("pane", _load_json(DATA, {}), arg=leaf, info=info), HTML)
        elif p.startswith("/seat/"):
            n = p[6:].strip("/")
            u = seat_bridge.uuid_for(n)
            panes = _panes()                          # s948: the desktop sidebar lists desk seats
            self._send(head + phone_render.page("seat", _load_json(DATA, {}), arg=n, uuid=u, panes=panes,
                                                on_desk=bool(u and any(x.get("uuid") == u for x in panes))), HTML)
        elif p.startswith("/thread/"):
            self._send(head + phone_render.page("thread", _load_json(DATA, {}), arg=unquote(p[8:])), HTML)
        elif p.startswith("/wi/"):
            self._send(head + phone_render.page("wi", _load_json(DATA, {}), arg=unquote(p[4:])), HTML)
        elif p == "/voice-test":                        # s942: iOS capability probe for the voice-mode design
            self._send(head + phone_render._shell("Voice test", VOICE_TEST_BODY, _load_json(DATA, {}), "seats", back="/seats"), HTML)
        elif p == "/seats":
            self._send(head + phone_render.page("seats", _load_json(DATA, {}), panes=_panes()), HTML)
        elif p == "/processes":
            self._send(head + phone_render.page("processes", _load_json(DATA, {}), proc=_load_json(PROC, {}),
                                                remote=remote_status()), HTML)
        elif p == "/shell":
            self._send(SHELL_HTML.encode("utf-8"), HTML)
        elif p == "/status.json":
            self._send(json.dumps(remote_status(), indent=1).encode(), "application/json; charset=utf-8")
        elif p == "/setup":
            self._send(head + phone_render.page("setup", _load_json(DATA, {}), extra="<style>#ra-bar{bottom:58px}</style>" + PWA_BAR), HTML)
        elif p == "/manifest.webmanifest":
            self._send(json.dumps(MANIFEST).encode(), "application/manifest+json")
        elif p == "/sw.js":
            self._send(SW_JS.encode(), "application/javascript")
        elif p.startswith("/icon-") and p.endswith(".png"):
            try:
                self._send(icon(int(p[6:-4])), "image/png")
            except Exception:
                self.send_error(404)
        elif p == "/vapid-public":
            self._send(vapid_public_b64().encode(), "text/plain")
        elif p == "/push-test":
            self._send(send_push("Vault", "Push works. Tap to land on seat 929.", "/seat/929", "test").encode(), "text/plain")
        elif p == "/notify-prefs":
            lvl, cd = _prefs()
            self._send(json.dumps({"level": lvl, "cooldown_min": int(cd)}).encode(), "application/json")
        elif p == "/attention":
            d = _load_json(DATA, {})
            body = {"generated": d.get("generated"), "at_desk_min": [s.get("user_min") for s in d.get("sessions") or []],
                    "attention": d.get("attention"), "pushed": len(_load_json(PUSHED, {}) or {}),
                    "push_log": _push_log[-20:]}
            self._send(json.dumps(body, indent=1).encode(), "application/json; charset=utf-8")
        elif p.startswith("/data"):
            self._send(DATA.read_bytes(), "application/json; charset=utf-8")
        elif p == "/health":
            self._send(b"ok", "text/plain")
        else:
            self.send_error(404)

    def _json_body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_POST(self):
        m = re.match(r"^/(seat|pane)/([0-9a-f]+)/(send|focus|keys|resume|answer|voice|voice-prime)$", self.path)
        if m:
            kind, ident, action = m.group(1), m.group(2), m.group(3)
            handle = seat_bridge.uuid_for(ident) if kind == "seat" else "leaf:" + ident
            body = self._json_body()
            if not handle:
                ok, msg = False, f"seat {ident} has no uuid in the registry"
            elif action == "focus":
                ok, msg = seat_bridge.focus(handle)
            elif action == "keys":
                ok, msg = seat_bridge.keys(handle, str(body.get("key", "")))
            elif action == "voice-prime":               # s942 voice mode: warm the whisper worker while the operator talks
                try:
                    ok, msg = True, voice.WORKER_PROC.prime()
                except Exception as e:
                    ok, msg = False, f"prime failed: {e.__class__.__name__}"
            elif action == "voice":                     # s942 voice mode: clip -> text; the phone puts it in the field
                self._send(json.dumps(voice.transcribe_clip(body)).encode(), "application/json")
                return
            elif action == "answer":                    # s942: a tapped choice = key presses into the pane, one eval each
                ks = [str(k) for k in (body.get("keys") or [])][:24]
                ok, msg = (False, "no keys") if not ks else (True, "done")
                for k in ks:
                    ok, msg = seat_bridge.keys(handle, k)
                    if not ok:
                        break
                    time.sleep(0.12)
                _log_answer(handle, ks, ok, msg)
            elif action == "resume":
                ok, msg = (seat_bridge.resume(handle) if kind == "seat" else (False, "only a Claude seat can be resumed"))
            else:
                ok, msg = seat_bridge.send(handle, body.get("text", ""))
            self._send(json.dumps({"ok": ok, "msg": ("done" if ok else msg)}).encode(), "application/json")
            return
        if self.path == "/seats/new":                   # s948: a fresh Claude seat on the desk
            body = self._json_body()
            ok, msg = seat_bridge.new_seat(str(body.get("profile") or "claude"), body.get("cwd") or None)
            self._send(json.dumps({"ok": ok, "msg": ("done" if ok else msg)}).encode(), "application/json")
            return
        if self.path == "/upload":
            body = self._json_body()
            raw_b64 = (body.get("data_b64") or "").split(",", 1)[-1]   # strip the data:...;base64, prefix
            name = str(body.get("name") or "photo")
            try:
                raw = base64.b64decode(raw_b64)
                assert raw
            except Exception:
                self._send(json.dumps({"ok": False, "msg": "bad image data"}).encode(), "application/json")
                return
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", name)[-64:].lstrip("._") or "photo"
            if "." not in safe:
                safe += ".jpg"
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            dest = UPLOAD_DIR / f"{stamp}-{safe}"
            i = 1
            while dest.exists():
                dest = UPLOAD_DIR / f"{stamp}-{i}-{safe}"
                i += 1
            dest.write_bytes(raw)
            self._send(json.dumps({"ok": True, "path": str(dest),
                                   "rel": f"01_Inbox/phone-uploads/{dest.name}",
                                   "bytes": len(raw)}).encode(), "application/json")
            return
        if self.path == "/notify-prefs":
            body = self._json_body()
            cur = _load_json(PREFS, {}) or {}
            if body.get("level") in ("off", "away", "all"):
                cur["level"] = body["level"]
            if "cooldown_min" in body:
                try:
                    cur["cooldown_min"] = max(0, int(body["cooldown_min"]))
                except Exception:
                    pass
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            PREFS.write_text(json.dumps(cur), encoding="utf-8")
            lvl, cd = _prefs()
            self._send(json.dumps({"level": lvl, "cooldown_min": int(cd)}).encode(), "application/json")
            return
        if self.path == "/restart":
            self._send(json.dumps({"ok": True, "msg": "restarting; poll /health"}).encode(), "application/json")
            threading.Timer(0.6, _restart_self).start()
            return
        if self.path == "/subscribe":
            n = int(self.headers.get("Content-Length", 0))
            try:
                sub = json.loads(self.rfile.read(n))
                assert sub.get("endpoint")
            except Exception:
                self.send_error(400)
                return
            self._send(f"{add_sub(sub)} device(s)".encode(), "text/plain")
        else:
            self.send_error(404)

    def _send(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if ctype.startswith("application/javascript"):
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", required=True, help="127.0.0.1 (behind tailscale serve) or this box's 100.x tailnet IP; never 0.0.0.0")
    ap.add_argument("--port", type=int, default=8378)
    a = ap.parse_args()
    if not (a.bind == "127.0.0.1" or a.bind.startswith("100.")):
        sys.exit("refusing to bind outside loopback / the tailnet range")
    threading.Thread(target=watcher, daemon=True, name="attention-watcher").start()
    ThreadingHTTPServer((a.bind, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
