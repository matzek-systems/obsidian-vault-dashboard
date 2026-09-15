"""Phone-native render of dashboard-data.json (Remote App phase 2, first cut).

Pure function of the JSON: page(kind, data, proc, arg, extra) -> bytes.
Kinds: home | seat | thread | wi | seats | processes | setup.
Every row is a link; nothing here is hand-fed (DL-668).
"""
import html
import json
import re
import threading
from datetime import datetime
from urllib.parse import quote

CSS = """
:root{--ground:#0c0c0c;--surface:#141414;--ink:#d4d4d4;--ink2:#8a8a8a;--line:#232323;--accent:#5a8ec7;
 --wait:#c08a4a;--work:#7ec77e;--idle:#6b6b6b;--chip:#1a1a1a;--note:#161616;--bad:#c77e7e}
html{color-scheme:dark}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:17px/1.4 -apple-system,"SF Pro Text",system-ui,sans-serif;padding:0 0 84px}
a{color:inherit;text-decoration:none}
.top{position:sticky;top:0;background:var(--ground);padding:14px 16px 8px;display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--line);z-index:5}
.top h1{font-size:22px;margin:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top .gen{color:var(--ink2);font-size:14px;margin-left:auto;white-space:nowrap}
.top a.back{color:var(--accent);font-size:17px;font-weight:600}
.band{margin:14px 12px 0}
.band h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin:0 4px 6px;display:flex;gap:8px;align-items:center}
.band h2 .n{background:var(--wait);color:#fff;border-radius:10px;padding:0 7px;font-size:13px}
.band h2 .n.q{background:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{display:block;padding:12px 14px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .t{font-size:18px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row .x{color:var(--ink2);font-size:16px;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row .m{color:var(--ink2);font-size:14px;margin-top:7px;display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.wh{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:14px;color:var(--ink2)}.wh span{color:var(--ink)}
.row .wh{font-size:13px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
.chip{font-size:13px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:var(--chip);color:var(--ink2);white-space:nowrap}
.st{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;white-space:nowrap}
.st::before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor}
.waiting{color:var(--wait)}.working{color:var(--work)}.idle{color:var(--idle)}.dead{color:var(--idle)}
.seat{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:15px;font-weight:700;color:var(--accent)}
.lead{margin:0;padding:12px 14px;font-size:17px;font-weight:600;line-height:1.35}.lead .seat{margin-right:2px}
.pchips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 8px}
.pchip{font:600 14px/1.2 -apple-system,system-ui,sans-serif;padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--chip);color:var(--ink);text-align:left;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pchip .st{font-size:12px;vertical-align:1px}.msg.k-you.pend{opacity:.6}
.pchip .f{color:var(--ink2);font-weight:400}.pchip.on{border-color:var(--accent);color:var(--accent)}.pchip.off{opacity:.4}
.push textarea{width:100%;font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--ground);color:var(--ink);resize:vertical}
.row.needs{border-left:3px solid var(--wait)}
.needyou{display:inline-block;background:var(--wait);color:#0c0c0c;font-weight:700;font-size:12px;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:6px;margin-bottom:7px}
.nav{position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--line);display:flex;padding:8px 0 max(8px,env(safe-area-inset-bottom));z-index:9}
.nav a{flex:1;text-align:center;font-size:13px;font-weight:600;color:var(--ink2);padding:6px 0}
.nav a.on{color:var(--accent)}
body.kbd .nav{display:none}
.btn{display:inline-block;padding:11px 15px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;font-size:16px;border:0;font-family:inherit}
.btn.alt{background:var(--chip);color:var(--ink)}
.acts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px;border-top:1px solid var(--line)}
.kv{padding:12px 14px;border-top:1px solid var(--line)}.kv:first-child{border-top:0}
.kv .k{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin-bottom:4px}
.kv .v{font-size:17px;white-space:pre-wrap;word-break:break-word}
.kv .v.q{font-size:19px;font-weight:600;color:var(--wait)}
.checklist{white-space:normal}
.chk{display:flex;gap:9px;align-items:flex-start;padding:5px 0;line-height:1.35;border-top:1px solid var(--line)}
.chk:first-child{border-top:0}
.chk .box{font-size:18px;color:var(--ink2);flex:none;line-height:1.25}
.chk.done .box{color:var(--work)}
.chk.done .ctxt{color:var(--ink2);text-decoration:line-through}
.chk .ctxt{font-size:16px;word-break:break-word}
.chain{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chain a,.chain .s{border:1px solid var(--line);border-radius:7px;padding:2px 8px;font-size:15px;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.chain a.live{border-color:var(--work);color:var(--work);font-weight:700}
.chain .ar{color:var(--ink2)}
.note{background:var(--note);color:var(--ink);padding:10px 14px;font-size:16px}
.empty{padding:14px;color:var(--ink2);font-size:16px}
.cal-day{padding:10px 14px;border-top:1px solid var(--line)}.cal-day:first-child{border-top:0}
.cal-h{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin-bottom:4px;display:flex;gap:8px}
.cal-h b{color:var(--ink)}.cal-day.today .cal-h b{color:var(--accent)}.cal-h .d{letter-spacing:0;text-transform:none}
.cal-it{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:16px;line-height:1.3}
.cal-it .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-k{flex:none;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:4px;background:#2a1a1a;color:var(--bad)}
.cal-k.start{background:#2a2114;color:var(--wait)}
.cal-w{flex:none;font-size:14px;color:var(--ink2);font-variant-numeric:tabular-nums}
.cal-none{color:var(--idle);font-size:15px;font-style:italic}
.cal-split{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
.cal-sub{min-width:0;padding:0 8px}.cal-sub:first-child{padding-left:0}.cal-sub+.cal-sub{border-left:1px solid var(--line)}
.cal-sub .sh{font-size:14px;color:var(--ink2);margin-bottom:3px}.cal-sub.wk .sh{color:var(--idle)}
.cal-sub .cal-it{flex-wrap:wrap;gap:4px;font-size:14px}
.cal-sub .cal-it .tx{flex-basis:100%;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--ink2)}
.cal-it{position:relative}.cal-a{display:flex;gap:8px;align-items:baseline;flex:1;min-width:0;color:inherit;text-decoration:none}
.cal-sub .cal-a{flex-wrap:wrap;gap:4px}.cal-sub .cal-a .tx{flex-basis:100%;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--ink2)}
.cal-x{flex:none;margin-left:auto;min-width:30px;min-height:30px;border:0;background:none;color:var(--idle);font-size:14px;padding:0}
.cal-sub .cal-x{position:absolute;top:-4px;right:-6px;min-width:26px;min-height:26px;font-size:12px}
.cal-cy{flex:none;font-size:11px;padding:0 5px;border:1px dashed var(--line);border-radius:4px;color:var(--ink2)}
.cal-sub .sh{display:flex;gap:4px;align-items:baseline}.cal-rs{margin-left:auto;border:0;background:none;color:var(--idle);font-size:12px;letter-spacing:0;text-transform:none;padding:0}
.reply textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--ground);color:var(--ink);resize:vertical;margin-top:4px}
.btn:disabled{opacity:.45}
.wis{display:flex;flex-wrap:wrap;gap:6px}
.wis a{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:14px;font-weight:600;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.chat{margin:10px 12px 0;display:flex;flex-direction:column;gap:8px}
.msg{border-radius:12px;padding:10px 12px;font-size:17px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
.msg.k-you{align-self:flex-end;background:var(--accent);color:#fff;max-width:88%}
.msg.k-you.cmd{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:15px}
.msg.k-seat{align-self:stretch;background:var(--surface);border:1px solid var(--line)}
.msg.k-tool{align-self:stretch;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:14px;line-height:1.35;color:var(--ink2);padding:2px 12px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
.msg.k-tool b{color:var(--ink);font-weight:700;margin-right:4px}
.msg.k-result{align-self:stretch;padding:0 12px}
.msg.k-result details{font-size:13px;color:var(--ink2)}.msg.k-result summary{cursor:pointer;display:block;list-style:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.msg.k-result summary::-webkit-details-marker{display:none}.msg.k-result summary::before{content:"→ ";opacity:.6}
.msg.k-result pre{white-space:pre-wrap;word-break:break-word;font-size:13px;margin:4px 0 0;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.msg.k-note{align-self:center;font-size:13px;color:var(--ink2)}
.msg.k-end{align-self:stretch;height:0;border-top:1px dashed var(--line);padding:0;margin:2px 0}
.msg .ts{display:block;font-size:11px;opacity:.7;margin-top:4px}
.msg strong.hd{display:block;margin-top:6px}.msg code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:14px;background:var(--chip);padding:1px 5px;border-radius:5px}
.msg pre.code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;line-height:1.35;background:var(--ground);border:1px solid var(--line);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:pre;margin:6px 0}
.msg a{color:var(--accent);text-decoration:underline}.msg.k-you a{color:#fff}
.msg table.md{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;margin:6px 0;font-size:14px;line-height:1.35;white-space:normal;-webkit-overflow-scrolling:touch}
.msg table.md th,.msg table.md td{border:1px solid var(--line);padding:5px 9px;text-align:left;vertical-align:top;min-width:64px}
.msg table.md th{background:var(--chip);font-weight:600;white-space:nowrap}.msg table.md td{max-width:320px}
.msg.k-live{align-self:stretch;display:flex;gap:8px;align-items:center;font-size:14px;color:var(--ink2);padding:4px 12px;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.msg.k-live .dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:var(--work);animation:pulse 1.2s ease-in-out infinite}
.msg.k-live.waiting .dot{background:var(--wait);animation:none}.msg.k-live .d{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes pulse{50%{opacity:.25}}
.msg.k-think{align-self:stretch;color:var(--ink2);font-style:italic;font-size:15px;line-height:1.4;padding:4px 12px 4px 14px;border-left:2px solid var(--line);border-radius:0;margin-left:12px}
.msg.k-think code{font-style:normal}
.composer{position:fixed;left:0;right:0;bottom:58px;background:var(--surface);border-top:1px solid var(--line);padding:8px 12px 6px;z-index:8}
.keys{display:flex;gap:6px;overflow-x:auto;padding-bottom:7px;-webkit-overflow-scrolling:touch}
.keys button{flex:0 0 auto;font:600 14px/1 -apple-system,system-ui,sans-serif;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--chip);color:var(--ink)}
.cform{display:flex;gap:8px;align-items:flex-end}
.cform textarea{flex:1;font:inherit;font-size:17px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--ground);color:var(--ink);resize:none;max-height:120px}
.ibtn{flex:0 0 auto;width:42px;height:42px;border-radius:10px;border:1px solid var(--line);background:var(--chip);color:var(--ink);display:flex;align-items:center;justify-content:center;padding:0}
.ibtn svg{width:22px;height:22px}
.escbtn{flex:0 0 auto;height:42px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--chip);color:var(--ink2);font:700 14px/1 -apple-system,system-ui,sans-serif}
.escbtn.hot{color:var(--accent);border-color:var(--accent)}
.ibtn.hot{color:var(--accent);border-color:var(--accent)}
.ibtn.mic{touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.ibtn.mic.rec{background:#c77e7e;border-color:#c77e7e;color:#fff;animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.more{position:absolute;right:12px;bottom:calc(100% + 4px);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:6px;display:none;flex-direction:column;min-width:200px;box-shadow:0 8px 28px rgba(0,0,0,.55);z-index:9}
.more.on{display:flex}
.mrow{display:flex;align-items:center;gap:10px;padding:11px 12px;border:0;background:transparent;color:var(--ink);font:600 15px/1.2 -apple-system,system-ui,sans-serif;border-radius:8px;text-align:left}
.mrow svg{width:20px;height:20px}.mrow:active{background:var(--chip)}.mrow.hot{color:var(--accent)}
.kb{font:700 12px/1 ui-monospace,"SF Mono",Menlo,monospace;border:1px solid currentColor;border-radius:5px;padding:3px 5px}
.msg.k-ask{align-self:stretch;background:var(--surface);border:1px solid var(--accent);border-radius:12px;padding:10px 12px;font-size:15px}
.msg.k-ask .qb+.qb{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.msg.k-ask .qh{font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);margin-bottom:4px}
.msg.k-ask .q{font-weight:600;line-height:1.35;margin-bottom:6px}
.msg.k-ask .o{display:block;width:100%;text-align:left;margin:6px 0 0;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--chip);color:var(--ink);font:inherit;font-size:15px}
.msg.k-ask .o b{display:block;font-weight:600}.msg.k-ask .o span{display:block;color:var(--ink2);font-size:13px;margin-top:2px}
.msg.k-ask .o.sel{border-color:var(--accent)}.msg.k-ask button:disabled{opacity:.55}
.msg.k-ask .arow{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}.msg.k-ask .hint{font-size:13px;color:var(--ink2)}
.msg.k-ask .lnk{background:none;border:0;padding:0;color:var(--accent);font:inherit;font-size:13px;text-decoration:underline}
.msg.k-ask .qb.wait{opacity:.45}.msg.k-ask .o.oth b{color:var(--ink2)}
.msg.k-ask.done{border-color:var(--line)}.msg.k-ask .ans{color:var(--work);font-weight:600;margin-top:8px;font-size:14px}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:74px;background:var(--chip);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;z-index:9;opacity:0;transition:opacity .2s;pointer-events:none;max-width:88%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toast.on{opacity:1}
.screen{margin:10px 12px;font:12px/1.35 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre;overflow-x:auto;background:var(--ground);color:var(--ink);border:1px solid var(--line);padding:10px;border-radius:10px;min-height:200px}
details.meta{margin:10px 12px 0}details.meta summary{padding:10px 14px;font-weight:600;cursor:pointer;color:var(--ink2);font-size:14px}
.side{display:none}
/* Desktop (session 948, operator direction): a thin conversation column so the eyes move less, the
   sessions list in a sidebar with Settings below it, Board and Processes reachable from the same
   sidebar. The phone layout above is untouched; this only applies from 900px. */
@media (min-width:900px){
 body,body.kbd{display:grid;grid-template-columns:260px minmax(0,1fr);padding:0!important;min-height:100vh;align-items:start}
 /* the composer view pads the BODY for its fixed bar; on the grid that padding sits below the
    sidebar's grid row and sticky pushes the sidebar off the top at the end of the scroll --
    the room for the bar goes on .main instead */
 .side{display:flex;flex-direction:column;position:sticky;top:0;height:100vh;background:var(--surface);border-right:1px solid var(--line);padding:14px 12px;gap:10px;overflow:auto}
 .sb-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
 .brand{font-weight:800;font-size:19px;padding:4px 6px}
 .side .newseat{padding:8px 11px;font-size:14px}
 .sb-h{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);padding:6px 6px 0}
 .sb-h .n{background:var(--accent);color:#fff;border-radius:10px;padding:0 7px;font-size:12px}
 .sb-list{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow:auto}
 .sb-seat{display:flex;align-items:center;gap:8px;padding:8px 8px;border-radius:9px;font-size:14px;line-height:1.3;color:var(--ink)}
 .sb-seat .st{font-size:0;gap:0}.sb-seat .st::before{width:8px;height:8px}
 .sb-seat .seat{font-size:13px}.sb-seat .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
 .sb-seat:hover{background:var(--chip)}.sb-seat.on{background:var(--chip);box-shadow:inset 3px 0 0 var(--accent)}
 .sb-list .empty{padding:8px;font-size:14px}
 .sb-nav{display:flex;flex-direction:column;border-top:1px solid var(--line);padding-top:8px;gap:2px}
 .sb-nav a{padding:8px 8px;border-radius:9px;font-size:14px;font-weight:600;color:var(--ink2)}
 .sb-nav a.on{color:var(--accent);background:var(--chip)}.sb-nav a:hover{background:var(--chip)}
 .sb-gen{color:var(--ink2);font-size:12px;padding:0 8px 4px}
 .main{width:100%;max-width:900px;margin:0 auto;padding:0 20px calc(var(--cb,84px) + 56px);min-width:0}
 .nav,body.kbd .nav{display:none}
 .top{padding-left:4px;padding-right:4px}.top .gen{display:none}
 .band,.chat,details.meta{margin-left:0;margin-right:0}
 .composer{left:260px;right:0;bottom:0;padding:10px 0 12px}
 .composer .cform,.composer .more{max-width:860px;margin-left:auto;margin-right:auto}
 .composer .cform{padding:0 20px}.composer .more{right:calc((100% - 860px)/2 + 20px)}
 .cform textarea{max-height:200px}
}
"""

# KEY_STRIP retired (s931): the full arrow/enter/tab strip overlapped the nav and was noise
# on the phone. Only Escape survives, now a chip in the composer row (s942: no status row either).

COMPOSER_JS = """
<script>
(function(){
  var BASE='@BASE@', MODE='@MODE@', off=null, lastTool='', lastThink='', live=null, tt=null, pend=[];
  var st=document.getElementById('cst'), ta=document.getElementById('ct'), chat=document.getElementById('chat'), scr=document.getElementById('scr'), eb=document.getElementById('escbtn');
  var mb=document.getElementById('moreb'), mo=document.getElementById('more');
  var micb=document.getElementById('micb'), spkb=document.getElementById('spkbtn'), spkl=document.getElementById('spklbl');
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function toast(m,long){st.textContent=m;st.classList.add('on');clearTimeout(tt);tt=setTimeout(function(){st.classList.remove('on');},long?5000:2000);}
  function near(){return (window.innerHeight+window.scrollY)>=(document.body.scrollHeight-200);}
  function add(e){var d=document.createElement('div');d.className='msg k-'+e.k+(e.cmd?' cmd':'');
    if(e.k==='you'&&pend.length){var pe=pend.shift();if(pe&&pe.parentNode){pe.remove();}}   /* the transcript's copy replaces the echo */
    if(e.k==='result'&&e['for']&&asks[e['for']]){var a=asks[e['for']];if(a.classList.contains('done')){return;}a.classList.add('done');a.querySelectorAll('button').forEach(function(x){x.disabled=true;});
      var an=document.createElement('div');an.className='ans';an.textContent='answered · '+(e.s||'');a.appendChild(an);return;}
    if(e.k==='tool'&&e.ask&&e.ask.length){renderAsk(d,e);lastTool='';lastThink='';}
    else if(e.k==='tool'){d.innerHTML='<b>'+esc(e.n)+'</b>'+esc(e.a||'');lastTool=e.n+(e.a?' '+e.a:'');lastThink='';}
    else if(e.k==='think'){d.innerHTML=e.h||esc(e.t);lastThink=e.s||'';lastTool='';}
    else if(e.k==='result'){d.innerHTML='<details><summary>'+esc(e.s||'result')+'</summary><pre>'+esc(e.t)+(e.more?' …':'')+'</pre></details>';}
    else if(e.k==='end'){lastTool='';lastThink='';}
    else if(e.k==='note'){d.textContent=e.t;}
    else{d.innerHTML=(e.h||esc(e.t))+(e.ts?'<span class="ts">'+e.ts+'</span>':'');if(e.k==='seat'){lastTool='';lastThink='';if(seen){speak(e.t);}}}
    if(live&&live.parentNode){chat.insertBefore(d,live);}else{chat.appendChild(d);}}
  var asks={};
  function renderAsk(d,e){d.className='msg k-ask';asks[e.id||'']=d;var html='';
    (e.ask||[]).forEach(function(q,qi){html+='<div class="qb'+(qi?' wait':'')+'" data-qi="'+qi+'">'+(q.h?'<div class="qh">'+esc(q.h)+'</div>':'')+'<div class="q">'+esc(q.q)+'</div>';
      (q.o||[]).forEach(function(o,oi){html+='<button type="button" class="o" data-oi="'+oi+'"><b>'+esc(o.l)+'</b>'+(o.d?'<span>'+esc(o.d)+'</span>':'')+'</button>';});
      html+='<button type="button" class="o oth" data-oi="'+(q.o||[]).length+'"><b>Other…</b><span>type your own answer below</span></button>';
      if(q.multi){html+='<div class="arow"><button type="button" class="btn conf">Confirm selection</button><span class="hint">tap to pick several</span></div>';}
      html+='</div>';});
    html+='<div class="arow"><span class="hint">a tap answers the seat</span>'+(e.ask.length===1&&!(e.ask[0]||{}).multi?'<button type="button" class="lnk chat">reply in chat instead</button>':'')+'</div>';
    d.innerHTML=html;
    d.onclick=function(ev){var b=ev.target.closest('button');if(!b||d.classList.contains('done')){return;}
      var qb=b.closest('.qb');if(!qb||qb.classList.contains('sent')||qb.classList.contains('wait')){return;}var q=(e.ask||[])[+qb.getAttribute('data-qi')]||{};
      var qi=+qb.getAttribute('data-qi'),last=qi===(e.ask||[]).length-1,multiQ=(e.ask||[]).length>1;
      if(b.classList.contains('o')){var oi=+b.getAttribute('data-oi');if(q.multi){b.classList.toggle('sel');return;}var oth=b.classList.contains('oth');if(oth){ta.focus();}
        b.classList.add('sel');answer(d,qb,['char:'+(oi+1)].concat(last&&multiQ&&!oth?['enter']:[]),oth);}
      else if(b.classList.contains('chat')){ta.focus();answer(d,qb,['char:'+(((q.o||[]).length)+2)],true);}
      else if(b.classList.contains('conf')){var sel=[];qb.querySelectorAll('.o.sel').forEach(function(x){sel.push(+x.getAttribute('data-oi'));});
        if(!sel.length){toast('pick at least one');return;}var hasO=!!qb.querySelector('.oth.sel');if(hasO){ta.focus();}
        answer(d,qb,keysFor(sel,(q.o||[]).length).concat(last?['enter']:[]),hasO);}};}
  function keysFor(idx,nopt){var ks=[];idx.sort(function(a,b){return a-b;});var pos=0;idx.forEach(function(i){while(pos<i){ks.push('down');pos++;}ks.push('char: ');});
    while(pos<nopt+1){ks.push('down');pos++;}ks.push('enter');return ks;}
  function answer(d,qb,ks,other){qb.querySelectorAll('button').forEach(function(x){x.disabled=true;});toast('answering…');
    post('answer',{keys:ks}).then(function(j){if(!j.ok){toast('answer failed: '+j.msg,true);qb.querySelectorAll('button').forEach(function(x){x.disabled=false;});return;}
      qb.classList.add('sent');var nx=qb.nextElementSibling;if(nx&&nx.classList.contains('qb')){nx.classList.remove('wait');}
      if(other){toast('type your answer and send');}setTimeout(poll,700);
      setTimeout(function(){if(!d.classList.contains('done')){toast('the seat has not confirmed yet · check the desk if it stays',true);}},6000);}).catch(function(){toast('answer failed',true);});}
  /* the seat's state lives in the stream as a pulsing line at the bottom (working: the
     current tool call; waiting: what it asked), not in a status row under the composer */
  function setLive(state,detail){
    var hot=(state==='working'||state==='waiting');
    if(eb){eb.classList.toggle('hot',hot);}if(mb){mb.classList.toggle('hot',hot);}
    if(!chat){return;}
    if(!hot){if(live){live.remove();live=null;}return;}
    if(!live){live=document.createElement('div');live.innerHTML='<span class="dot"></span><span class="d"></span>';chat.appendChild(live);}
    live.className='msg k-live '+state;
    var txt=(state==='waiting')?('waiting for you'+(detail?' · '+detail:''))
           :((lastTool&&(!detail||detail.indexOf('running')===0))?lastTool:(lastThink?('thinking · '+lastThink):(detail||'working')));
    live.querySelector('.d').textContent=txt;}
  function poll(){ if(document.visibilityState!=='visible'){return;}
    if(MODE==='chat'){
      fetch(BASE+'/feed'+(off===null?'':'?since='+off)).then(function(r){return r.json();}).then(function(j){
        var was=near()||off===null;(j.entries||[]).forEach(add);off=j.offset;setLive(j.state,j.detail);seen=true;
        if(was){window.scrollTo(0,document.body.scrollHeight);}}).catch(function(){});
    }else{
      fetch(BASE+'/screen').then(function(r){return r.text();}).then(function(t){var was=near();scr.textContent=t;if(was){window.scrollTo(0,document.body.scrollHeight);}}).catch(function(){});
    }}
  poll();setInterval(poll,2500);
  function post(k,body){return fetch(BASE+'/'+k,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json();});}
  /* voice mode (s942): hold the mic, release to send the clip to the box; the transcript lands in the
     field for a look before sending. 'Read replies aloud' speaks NEW seat text on the phone itself. */
  var speakOn=false,seen=false;try{speakOn=localStorage.getItem('vr_speak')==='1';}catch(e){}
  function spkLabel(){if(spkl){spkl.textContent='Read replies aloud: '+(speakOn?'on':'off');}}
  spkLabel();
  function speak(t){if(!speakOn||!window.speechSynthesis||!t){return;}var s=String(t).replace(/```[\s\S]*?```/g,' code block ').replace(/[`*_#>|]/g,'').slice(0,900);
    speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(s));}
  if(spkb){spkb.onclick=function(){speakOn=!speakOn;try{localStorage.setItem('vr_speak',speakOn?'1':'0');}catch(e){}spkLabel();if(mo){mo.classList.remove('on');}
    if(window.speechSynthesis){speechSynthesis.cancel();if(speakOn){speechSynthesis.speak(new SpeechSynthesisUtterance('Replies will be read aloud.'));}}};}
  var rec=null,recChunks=[],recT0=0,recStream=null;
  function micType(){var ts=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    for(var i=0;i<ts.length;i++){if(window.MediaRecorder&&MediaRecorder.isTypeSupported(ts[i])){return ts[i];}}return '';}
  function recStart(ev){ev.preventDefault();if(rec||micb.classList.contains('rec')){return;}
    if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder)){toast('no microphone access in this browser',true);return;}
    post('voice-prime',{}).catch(function(){});micb.classList.add('rec');toast('listening… release to send');
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(st){
      if(!micb.classList.contains('rec')){st.getTracks().forEach(function(t){t.stop();});return;}
      recStream=st;var mt=micType();try{rec=new MediaRecorder(st,mt?{mimeType:mt}:undefined);}catch(e){rec=new MediaRecorder(st);}
      recChunks=[];recT0=Date.now();
      rec.ondataavailable=function(e){if(e.data&&e.data.size){recChunks.push(e.data);}};
      rec.onstop=function(){var ms=Date.now()-recT0;st.getTracks().forEach(function(t){t.stop();});recStream=null;
        var b=new Blob(recChunks,{type:rec.mimeType||mt||'audio/webm'});rec=null;
        if(ms<500||b.size<800){toast('hold the mic while you talk');return;}
        toast('transcribing…',true);var fr=new FileReader();
        fr.onload=function(){post('voice',{data_b64:fr.result,mime:b.type,ms:ms}).then(function(j){
          if(!j.ok){toast('voice failed: '+(j.error||''),true);return;}var t=(j.text||'').trim();if(!t){toast('heard nothing');return;}
          ta.value=(ta.value?ta.value.replace(/\s+$/,'')+' ':'')+t;ta.focus();ta.dispatchEvent(new Event('input'));
          toast('transcribed in '+j.secs+'s'+(j.load_sec&&j.secs>15?' (model load '+Math.round(j.load_sec)+'s)':''));}).catch(function(){toast('voice failed',true);});};
        fr.readAsDataURL(b);};
      rec.start();}).catch(function(e){micb.classList.remove('rec');toast('mic refused: '+e.name,true);});}
  function recStop(ev){if(ev){ev.preventDefault();}if(!micb.classList.contains('rec')){return;}micb.classList.remove('rec');
    if(rec&&rec.state==='recording'){rec.stop();}else if(recStream){recStream.getTracks().forEach(function(t){t.stop();});recStream=null;}}
  if(micb){micb.addEventListener('pointerdown',recStart);micb.addEventListener('pointerup',recStop);micb.addEventListener('pointercancel',recStop);
    micb.addEventListener('pointerleave',recStop);micb.addEventListener('contextmenu',function(e){e.preventDefault();});}
  if(mb&&mo){mb.onclick=function(ev){ev.stopPropagation();mo.classList.toggle('on');};
    document.addEventListener('click',function(ev){if(mo.classList.contains('on')&&!mo.contains(ev.target)&&ev.target!==mb&&!mb.contains(ev.target)){mo.classList.remove('on');}});}
  if(eb){eb.onclick=function(){if(mo){mo.classList.remove('on');}post('keys',{key:'esc'}).then(function(j){toast(j.ok?'esc sent':'esc failed: '+j.msg,!j.ok);setTimeout(poll,600);});};}
  var enb=document.getElementById('entbtn');
  if(enb){enb.onclick=function(){if(mo){mo.classList.remove('on');}post('keys',{key:'enter'}).then(function(j){toast(j.ok?'enter sent':'enter failed: '+j.msg,!j.ok);setTimeout(poll,600);});};}
  var pf=document.getElementById('photof'), pb=document.getElementById('photob');
  if(pb&&pf){pb.onclick=function(){if(mo){mo.classList.remove('on');}pf.click();};
    pf.onchange=function(){var f=pf.files&&pf.files[0];if(!f){return;}
      toast('uploading photo…',true);
      var rd=new FileReader();
      rd.onload=function(){
        fetch('/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,data_b64:rd.result})}).then(function(r){return r.json();}).then(function(j){
          if(j.ok){var pre=ta.value?ta.value+'\\n':'';ta.value=pre+j.path;ta.style.height='auto';ta.style.height=Math.min(120,ta.scrollHeight)+'px';toast('photo saved, path added');ta.focus();}
          else{toast('upload failed: '+(j.msg||''),true);}
        }).catch(function(){toast('upload failed',true);});
        pf.value='';};
      rd.readAsDataURL(f);};}
  document.getElementById('cf').onsubmit=function(e){e.preventDefault();var t=ta.value.trim();if(!t){return false;}
    toast('sending…');post('send',{text:t}).then(function(j){if(j.ok){ta.value='';ta.style.height='auto';toast('sent');
        if(chat){var d=document.createElement('div');d.className='msg k-you pend';d.innerHTML=esc(t)+'<span class="ts">sent · waiting for the seat to pick it up</span>';
          if(live&&live.parentNode){chat.insertBefore(d,live);}else{chat.appendChild(d);}pend.push(d);window.scrollTo(0,document.body.scrollHeight);}
        setTimeout(poll,1200);}else{toast('failed: '+j.msg,true);}});return false;};
  // s948 (phone, round 3): 4 lines on the phone (6 hid the transcript's tail under the bar + keyboard),
  // 8 on the desktop grid. Enter sends; Shift+Enter is a newline. iOS can deliver the return key as a
  // keydown with key 'Unidentified' (autocorrect/predictive composition), so beforeinput's
  // insertLineBreak is the second door to send through; shift state is tracked from keydown.
  var MAXH=window.matchMedia('(min-width:900px)').matches?200:96, shiftDown=false;
  function grow(){ta.style.height='auto';ta.style.height=Math.min(MAXH,ta.scrollHeight)+'px';}
  function sendNow(){document.getElementById('cf').requestSubmit();}
  ta.addEventListener('input',grow);
  ta.addEventListener('keydown',function(e){shiftDown=!!e.shiftKey;if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendNow();}});
  ta.addEventListener('keyup',function(e){shiftDown=!!e.shiftKey;});
  ta.addEventListener('beforeinput',function(e){if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!shiftDown){e.preventDefault();sendNow();}});
  // The bar's real height is the page's bottom room (--cb); the page only follows to the bottom when
  // the reader was there and is not typing (a scroll under an open iOS keyboard fights Safari's own).
  var comp=document.querySelector('.composer');
  if(comp&&window.ResizeObserver){new ResizeObserver(function(){var was=near();
    document.documentElement.style.setProperty('--cb',(comp.offsetHeight+12)+'px');
    if(was&&document.activeElement!==ta){window.scrollTo(0,document.body.scrollHeight);}}).observe(comp);}
  // iOS lays fixed elements against the layout viewport, which the keyboard does not shrink: the bar
  // would sit behind the keyboard. Pin it to the visual viewport's bottom edge instead.
  var vv=window.visualViewport;
  if(comp&&vv){var pin=function(){var off=Math.max(0,Math.round(window.innerHeight-vv.height-vv.offsetTop));comp.style.bottom=off+'px';};
    vv.addEventListener('resize',pin);vv.addEventListener('scroll',pin);pin();}
  var fb=document.getElementById('fb');
  if(fb){fb.onclick=function(){post('focus').then(function(j){toast(j.ok?'focused on desk':'focus failed: '+j.msg,!j.ok);});};}
})();
</script>"""

CAM_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
           '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>')


MIC_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">'
           '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>')
MORE_SVG = ('<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/>'
            '<circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>')


def composer(base: str, mode: str, placeholder: str, open_link: str = "") -> str:
    # s942 (operator, from the phone): the return key already sends (enterkeyhint="send"), so no
    # Send button; no status row: state is a live line in the stream, transient messages toast.
    # Same evening, second pass: Esc next to the field was "inconveniently placed", so the photo
    # upload and Escape fold into one "..." menu; the dots light up while the seat works.
    return ('<style>.nav{display:none}.composer{bottom:0}body{padding-bottom:var(--cb,84px)}</style>'
            '<div class="composer">'
            f'<form id="cf" class="cform"><textarea id="ct" rows="1" enterkeyhint="send" placeholder="{h(placeholder)}"></textarea>'
            f'<button type="button" class="ibtn mic" id="micb" aria-label="Hold to talk" title="Hold to talk">{MIC_SVG}</button>'
            f'<button type="button" class="ibtn" id="moreb" aria-label="More" title="More">{MORE_SVG}</button></form>'
            f'<div class="more" id="more"><button type="button" class="mrow" id="photob">{CAM_SVG} Add photo</button>'
            '<button type="button" class="mrow" id="escbtn"><span class="kb">Esc</span> Send Escape to the seat</button>'
            '<button type="button" class="mrow" id="entbtn"><span class="kb">Enter</span> Confirm a prompt on the seat</button>'
            '<button type="button" class="mrow" id="spkbtn"><span class="kb">Aa</span> <span id="spklbl">Read replies aloud: off</span></button></div>'
            '<input type="file" id="photof" accept="image/*" hidden>'
            '<span id="cst" class="toast"></span></div>'
            + COMPOSER_JS.replace("@BASE@", base).replace("@MODE@", mode))


SW_REG = "<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}</script>"

KIND_DOT = {"question": "waiting", "artifact": "idle", "rule": "wait", "handoff": "working"}


def h(s) -> str:
    return html.escape("" if s is None else str(s), quote=True)


def ago(m) -> str:
    if m is None:
        return ""
    try:
        m = float(m)
    except Exception:
        return ""
    if m < 0:
        return f"{int(-m / 1440)}d overdue"
    if m < 1:
        return "now"
    if m < 60:
        return f"{int(m)}m"
    if m < 1440:
        return f"{int(m / 60)}h"
    return f"{int(m / 1440)}d"


def gen_time(d) -> str:
    g = d.get("generated") or ""
    try:
        return datetime.fromisoformat(g).strftime("%H:%M")
    except Exception:
        return g[11:16]


def chip(text, cls="chip") -> str:
    return f'<span class="{cls}">{h(text)}</span>' if text else ""


def st_chip(state) -> str:
    return f'<span class="st {h(state or "idle")}">{h(state or "idle")}</span>'


def wis_links(ids) -> str:
    return '<div class="wis">' + "".join(f'<a href="/wi/{h(i)}">{h(i)}</a>' for i in ids or []) + "</div>" if ids else ""


def seat_url(n) -> str:
    return f"/seat/{h(n)}"


import vaultpath

VAULT_NAME = vaultpath.VAULT_NAME
ROADMAPS_DIR = "00_System/AI/Claude/Roadmaps"
ACTIVE_WINDOW = 20
_TERMINAL = {"done", "killed", "superseded", "dormant", "deferred"}


def obs_open(vault_rel_path) -> str:
    """obsidian://open deep-link -- opens the vault file in Obsidian (mobile too)."""
    return f"obsidian://open?vault={quote(VAULT_NAME)}&file={quote(vault_rel_path)}"


def roadmap_file(lane) -> str:
    """lane -> its Roadmaps/*.md file (works for _System too)."""
    return f"{ROADMAPS_DIR}/{lane} Roadmap.md" if lane else ""


_TASK_RE = re.compile(r"^\s*- \[( |x|X)\]\s*(.+)$")   # same shape as dashboard_data CHECK
_HDR_RE = re.compile(r"^#{2,3} ")                     # next '## ' or '### ' ends a WI block


def wi_tasks(lane, wid):
    """Parse a WI's checklist lines from its roadmap block: [(done, text), ...].

    The JSON carries only tasks_done/tasks_total counts (operator, session 954:
    the WI page showed '10 of 19' with no checkboxes), so read the actual task
    lines from the roadmap. Prefer the lane's file; fall back to scanning every
    roadmap when the lane is unknown. Block boundary = next '##'/'###' heading,
    matching the count parser.
    """
    roadmaps = vaultpath.CLAUDE_DIR / "Roadmaps"
    files = []
    f = roadmaps / f"{lane} Roadmap.md"
    if lane and f.exists():
        files.append(f)
    if not files:
        files = sorted(roadmaps.glob("*.md"))
    hdr = re.compile(r"^### +" + re.escape(str(wid)) + r"\b")
    for path in files:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        start = next((i for i, ln in enumerate(lines) if hdr.match(ln)), None)
        if start is None:
            continue
        tasks = []
        for ln in lines[start + 1:]:
            if _HDR_RE.match(ln):
                break
            m = _TASK_RE.match(ln)
            if m:
                tasks.append((m.group(1) in ("x", "X"), m.group(2).strip()))
        return tasks
    return []


def vault_rel(p):
    """Vault-relative path for an absolute path inside the vault, else None."""
    return vaultpath.vault_rel(p)


def obs_btn(vault_rel_path, label="Open in Obsidian", cls="btn alt") -> str:
    return f'<a class="{cls}" href="{h(obs_open(vault_rel_path))}">{h(label)}</a>' if vault_rel_path else ""


def obs_file_link(path) -> str:
    """A vault path shown as its basename, clickable into Obsidian if in-vault."""
    name = str(path).replace("\\", "/").rsplit("/", 1)[-1]
    rel = vault_rel(path)
    return f'<a href="{h(obs_open(rel))}" style="color:var(--accent)">{h(name)}</a>' if rel else h(name)


def wi_index(d) -> dict:
    """id -> merged WI record from every lane's wis/now/next/waiting (has due_in, lane, next)."""
    idx = {}
    for L in d.get("lanes") or []:
        for k in ("wis", "now", "next", "waiting"):
            for w in L.get(k) or []:
                if w and w.get("id"):
                    idx.setdefault(w["id"], {}).update(w)
    return idx


def overdue_wis(d) -> list:
    rows = [w for w in wi_index(d).values()
            if isinstance(w.get("due_in"), (int, float)) and w["due_in"] < 0 and w.get("status") not in _TERMINAL]
    rows.sort(key=lambda w: (w["due_in"], str(w.get("id"))))
    return rows


def latest_session_n(d) -> int:
    ns = [s.get("n") or 0 for s in d.get("threads_seats") or []]
    for t in d.get("threads") or []:
        ns += [c.get("n") or 0 for c in t.get("chain") or []]
    return max(ns) if ns else 0


def overdue_row(w) -> str:
    days = -int(w["due_in"])
    text = w.get("next") or w.get("next_task") or w.get("title") or ""
    lane = "System" if w.get("lane") == "_System" else w.get("lane")
    return (f'<a class="row" href="/wi/{h(w.get("id"))}"><div class="t"><span class="seat">{h(w.get("id"))}</span> {h(w.get("title") or "")}</div>'
            f'<div class="x">{h(text)}</div><div class="m">{chip(lane)}'
            f'<span style="color:var(--wait);font-weight:700">{days}d overdue</span></div></a>')


def _cal_x(key, date, label) -> str:
    """Hide-from-the-dashboard button (POST /calendar/hide); Outlook never changes."""
    if not key:
        return ""
    return (f'<button type="button" class="cal-x" data-key="{h(key)}" data-date="{h(date)}" data-label="{h((label or "")[:80])}"'
            ' aria-label="hide from the dashboard">&#x2715;</button>')


def _cal_items(day, compact) -> str:
    """One day's explicit items: WIs due / starting that day (tap -> WI page),
    then Outlook appointments. Same order and rules as the desktop calendar.ts,
    each with the dashboard-only hide button."""
    out = []
    for w in day.get("wis") or []:
        kind = "start" if w.get("kind") == "start" else "due"
        out.append(f'<div class="cal-it"><a class="cal-a" href="/wi/{h(w.get("id"))}"><span class="cal-k {kind}">{kind}</span>'
                   f'<span class="seat">{h(w.get("id"))}</span><span class="tx">{h(wi_short(w.get("title")))}</span></a>'
                   f'{_cal_x(w.get("key"), day.get("date"), w.get("id"))}</div>')
    for e in day.get("events") or []:
        when = "all day" if e.get("all_day") else h(e.get("start") or "")
        carry = '<span class="cal-cy">yesterday</span>' if e.get("carry") else ""
        out.append(f'<div class="cal-it"><span class="cal-w">{when}</span>{carry}<span class="tx">{h(e.get("subject"))}</span>'
                   f'{_cal_x(e.get("key"), e.get("date"), e.get("subject"))}</div>')
    if not out:
        return f'<div class="cal-none">{"&mdash;" if compact else "nothing dated"}</div>'
    return "".join(out)


def _cal_restore(day, compact=False) -> str:
    n = int(day.get("hidden") or 0)
    if not n:
        return ""
    dates = ",".join(day.get("hidden_dates") or [day.get("date") or ""])
    text = f"&#x21BA; {n}" if compact else f"{n} hidden &#x21BA;"
    return f'<button type="button" class="cal-rs" data-dates="{h(dates)}" aria-label="show {n} hidden again">{text}</button>'


CAL_JS = """
<script>
document.addEventListener('click',function(e){
  var x=e.target.closest('.cal-x'), rs=e.target.closest('.cal-rs');
  if(!x&&!rs){return;}
  e.preventDefault();
  var url=x?'/calendar/hide':'/calendar/restore';
  var body=x?{key:x.getAttribute('data-key'),date:x.getAttribute('data-date'),label:x.getAttribute('data-label')}
            :{dates:(rs.getAttribute('data-dates')||'').split(',').filter(Boolean)};
  var row=x?x.closest('.cal-it'):null; if(row){row.style.display='none';} if(rs){rs.disabled=true;rs.textContent='restoring…';}
  fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();})
    .then(function(j){if(!j.ok){if(row){row.style.display='';}alert('Calendar: '+j.msg);}else if(rs){setTimeout(function(){location.reload();},4000);}})
    .catch(function(){if(row){row.style.display='';}});
});
</script>"""


def calendar_band(d) -> str:
    """The calendar area (SYS-485, operator layout s975): today, tomorrow, and a
    `next` block split into the three days after -- explicit dates only (Outlook,
    `due:`, `start_by:`), no derived plan. Empty string when the block is absent."""
    cal = d.get("calendar") or {}
    days = cal.get("days") or []
    if len(days) < 5:
        return ""

    def label(day):
        return f'{h(day.get("dow"))} {h(day.get("day"))}'
    body = ""
    for day, name, cls in ((days[0], "Today", "today"), (days[1], "Tomorrow", "")):
        body += (f'<div class="cal-day {cls}"><div class="cal-h"><b>{name}</b><span class="d">{label(day)}</span>{_cal_restore(day)}</div>'
                 f'{_cal_items(day, False)}</div>')
    subs = "".join(f'<div class="cal-sub{" wk" if day.get("weekend") else ""}"><div class="sh">{label(day)}{_cal_restore(day, True)}</div>{_cal_items(day, True)}</div>'
                   for day in days[2:5])
    body += f'<div class="cal-day"><div class="cal-h"><b>Next</b></div><div class="cal-split">{subs}</div></div>'
    err = f' <span class="chip" style="color:var(--wait)">outlook unavailable</span>' if cal.get("error") else ""
    return f'<div class="band"><h2>Calendar{err}</h2><div class="card">{body}</div></div>{CAL_JS}'


DO_NOW_CAP = 5


def surface_row(r) -> str:
    """One SYS-518 ranking-surface row (Big rocks / Do now), the desktop panel's
    surfaces.ts row in phone form: rank + id + short title, the WI's next step
    (the until-fact when the score is undetermined), lane, effort, overdue or
    start-now. Taps through to the WI page, which carries Push to a seat."""
    lane = re.sub(r"\s*Roadmap$", "", str(r.get("lane") or "")).lstrip("_") or None
    text = f"until: {r['until']}" if r.get("undetermined") and r.get("until") else (r.get("next") or r.get("title") or "")
    rank = "?" if r.get("undetermined") else r.get("rank")
    bits = []
    if r.get("effort") is not None:
        bits.append(f"<span>e{h(r['effort'])}</span>")
    if r.get("cost"):
        bits.append(f"<span>{h(r['cost'])}</span>")
    if (r.get("overdue_days") or 0) > 0:
        bits.append(f'<span style="color:var(--wait);font-weight:700">{h(r["overdue_days"])}d overdue</span>')
    elif r.get("past_start_by"):
        bits.append('<span style="color:var(--wait);font-weight:700">start now</span>')
    return (f'<a class="row" href="/wi/{h(r.get("id"))}"><div class="t"><b>{h(rank)}</b> <span class="seat">{h(r.get("id"))}</span> {h(wi_short(r.get("title")))}</div>'
            f'<div class="x">{h(text)}</div><div class="m">{chip(lane)}{"".join(bits)}</div></a>')


def _fold(label, rows) -> str:
    return ('<details class="older"><summary style="padding:12px 14px;color:var(--ink2);font-weight:600;cursor:pointer;border-top:1px solid var(--line)">'
            f'{h(label)} <span class="n q" style="background:var(--idle)">{len(rows)}</span></summary>'
            + "".join(surface_row(r) for r in rows) + "</details>")


def surfaces_bands(d) -> list:
    """Big rocks + Do now from data.surfaces (absent on the legacy scoring model or pre-flip
    data). Do now shows the operator-hands top 5; the rest and the seat-runnable rows (the
    nightly run's queue) fold."""
    s = d.get("surfaces") or {}
    if not s or s.get("error"):
        return []
    out = []
    rocks = s.get("big_rocks") or []
    if rocks:
        out.append('<div class="band"><h2>Big rocks</h2><div class="card">' + "".join(surface_row(r) for r in rocks) + "</div></div>")
    rows = s.get("do_now") or []
    hands = [r for r in rows if (r.get("actor") or {}).get("who") != "seat"]
    seat = [r for r in rows if (r.get("actor") or {}).get("who") == "seat"]
    if rows:
        card = "".join(surface_row(r) for r in hands[:DO_NOW_CAP])
        if len(hands) > DO_NOW_CAP:
            card += _fold("more", hands[DO_NOW_CAP:])
        if seat:
            card += _fold("seat-runnable", seat)
        out.append(f'<div class="band"><h2>Do now <span class="n q">{len(hands)}</span></h2><div class="card">{card}</div></div>')
    return out


def live_by_n(d) -> dict:
    """Seats with a transcript on disk. Registry rows never stamped closed but with
    no JSONL (ghosts: 412, 395, 394...) have no active_min and are not seats."""
    return {int(s["n"]): s for s in d.get("sessions") or []
            if str(s.get("n", "")).isdigit() and s.get("active_min") is not None}


def thread_for_seat(d, n):
    for t in d.get("threads") or []:
        if any(int(l.get("n", -1)) == int(n) for l in t.get("live") or []):
            return t
    return None


NAV = (("home", "/", "Board"), ("seats", "/seats", "Seats"), ("processes", "/processes", "Processes"),
       ("setup", "/setup", "Settings"))

# Per-request desk pane list (set by page()) so every view, not just /seats, can tell which live
# seats sit in a workspace-shell pane on the desk. The sidebar and the home Seats band read it.
_ctx = threading.local()


def desk_ns(panes=None) -> set:
    panes = panes if panes is not None else getattr(_ctx, "panes", None)
    return {int(p["n"]) for p in panes or [] if str(p.get("n") or "").isdigit()}


def desk_known() -> bool:
    return getattr(_ctx, "panes", None) is not None


def sidebar(d, active, current_n=None) -> str:
    """Desktop-only (session 948, operator direction on record): the ChatGPT shape. New seat on
    top, the live seats as a list, Board / Processes / Settings underneath. Hidden on the phone."""
    live = sorted(live_by_n(d).values(), key=lambda s: ({"waiting": 0, "working": 1}.get(s.get("state"), 2), -(int(s.get("n") or 0))))
    on = desk_ns()
    rows = []
    for s in live:
        n = int(s.get("n") or 0)
        if desk_known() and n not in on:
            continue                                   # detached transcripts stay on the Seats page's fold
        label = seat_label(d, s)[0]
        cls = "sb-seat" + (" on" if str(n) == str(current_n) else "")
        rows.append(f'<a class="{cls}" href="{seat_url(n)}"><span class="st {h(s.get("state") or "idle")}"></span>'
                    f'<span class="seat">{n}</span><span class="l">{h(label)}</span></a>')
    nav = "".join(f'<a href="{href}" class="{"on" if key == active else ""}">{label}</a>' for key, href, label in NAV if key != "seats")
    return ('<aside class="side"><div class="sb-top"><a class="brand" href="/">Vault</a>'
            '<button type="button" class="btn newseat" title="Open a new Claude seat on the desk">+ New seat</button></div>'
            f'<a class="sb-h" href="/seats">Seats <span class="n q">{len(rows)}</span></a><div class="sb-list">'
            + ("".join(rows) or '<div class="empty">No seat on the desk.</div>') + "</div>"
            f'<div class="sb-nav">{nav}</div><div class="sb-gen">{gen_time(d)}</div></aside>')


def _shell(title, body, d, active, back=None, extra="", current_n=None) -> bytes:
    nav = "".join(f'<a href="{href}" class="{"on" if key == active else ""}">{label}</a>' for key, href, label in NAV)
    # No header timestamp on the phone: the OS status-bar clock sits directly
    # above it, so it was redundant (operator, session 954). The desktop sidebar
    # keeps its own sb-gen time.
    top = (f'<a class="back" href="{h(back)}">&#8249; Back</a>' if back else "") + f"<h1>{h(title)}</h1>"
    # s931: hide the bottom nav whenever a textarea/input has focus (operator: "bottom bar
    # should be hidden when typing"). Composer views already hide nav outright; this covers
    # every other view with a field.
    kbd = ("<script>['focusin','focusout'].forEach(function(ev){addEventListener(ev,function(e){"
           "var t=e.target;if(t&&(t.tagName==='TEXTAREA'||t.tagName==='INPUT')){"
           "document.body.classList.toggle('kbd',ev==='focusin');}});});</script>")
    page = (f"<title>{h(title)}</title><style>{CSS}</style>{SW_REG}{sidebar(d, active, current_n)}"
            f"<main class=\"main\"><div class=\"top\">{top}</div>{body}{extra}</main><nav class=\"nav\">{nav}</nav>{kbd}{NEW_SEAT_JS}")
    return page.encode("utf-8")


# ---------------------------------------------------------------- rows

def attention_row(r) -> str:
    kind = r.get("kind")
    if kind in ("question", "artifact") and r.get("seat"):
        href = seat_url(r["seat"])
    elif kind == "rule":
        href = f"/wi/{h(r.get('label'))}"
    else:
        href = "/"
    label = {"question": "asks", "artifact": "finished", "rule": "overdue", "handoff": "handoff"}.get(kind, kind)
    seat = f'<span class="seat">{h(r["seat"])}</span>' if r.get("seat") else ""
    text = r.get("text") or ""
    if kind == "artifact" and r.get("paths"):
        text = (r["paths"][-1].replace("\\", "/").rsplit("/", 1)[-1]) + " · " + text
    return (f'<a class="row" href="{href}"><div class="t">{h(r.get("label"))}</div><div class="x">{h(text)}</div>'
            f'<div class="m">{seat}<span class="st {KIND_DOT.get(kind, "idle")}">{label}</span>{chip(r.get("lane"))}'
            f'<span>{h(ago(r.get("since_min")))}</span></div></a>')


def wi_short(title) -> str:
    """A WI's name without its explainer: cut at the first ' -- ', ': ' or ' ('."""
    t = re.split(r"\s+[\u2014\u2013-]\s+|:\s+|\s+\(", str(title or ""), 1)[0].strip()
    return t[:48]


def seat_lane(d, s):
    """Declared lane, else the lane the thread board derived from the seat's own paths."""
    if s.get("lane"):
        return s["lane"]
    if s.get("lane_tail"):
        return s["lane_tail"]
    for r in (d or {}).get("threads_seats") or []:
        if str(r.get("n")) == str(s.get("n")) and r.get("lane"):
            return r["lane"]
    return None


def seat_label(d, s) -> tuple[str, str, str | None]:
    """(label, source, wi) -- what the seat is on, in order of trust: the declared focus; the
    WI its transcript tail names most; the repo / area its tool calls touch; and only then
    Claude Code's auto-title, which is minted from the FIRST prompt and never regenerated
    (s942: seat 939 still read "Workspace-shell paste failing" a day into website work)."""
    if s.get("focus"):
        return s["focus"], "focus", (s.get("wis") or [None])[0]
    wid = s.get("wi_lead")
    w = wi_index(d).get(wid) if (d and wid) else None
    if w and w.get("title"):
        return f"{wid} {wi_short(w['title'])}", "tail", wid
    wh = s.get("where") or {}
    if wh.get("root"):
        return wh["root"], "where", None
    if s.get("title"):
        return s["title"], "auto", None
    if s.get("active_min") is not None:                 # older than the state window: nothing but an age
        return f"quiet for {ago(s['active_min'])}", "quiet", None
    return f"seat {s.get('n')}", "auto", None


def where_line(s, with_root=True) -> str:
    """'mm-site-mapclone &rsaquo; layout.tsx' -- the repo or vault area the seat's newest tool
    calls touched, from seat_state.where."""
    wh = s.get("where") or {}
    if not wh.get("root"):
        return ""
    f = wh.get("file") or ""
    root = f'<span>{h(wh["root"])}</span>' if with_root else ""
    sep = " &rsaquo; " if (root and f) else ""
    inner = root + sep + h(f)
    return f'<div class="wh">{inner}</div>' if inner else ""


def seat_row(s, d=None) -> str:
    n = s.get("n")
    detail = s.get("detail") or ""
    label, src, wid = seat_label(d, s)
    line = s.get("question") or s.get("lead") or s.get("last_line") or (s.get("zone") if src == "focus" else s.get("focus")) or ""
    a = ago(s.get("user_min"))
    typed = ("typed just now" if a == "now" else f"typed {a} ago") if s.get("user_min") is not None else ""
    if not typed and s.get("active_min") is not None and src == "quiet":
        typed = f"last active {ago(s['active_min'])} ago"
    waiting = s.get("state") == "waiting"          # the "waiting on you" signal -- a display, not a push
    badge = '<div class="needyou">waiting on you</div>' if waiting else ""
    cls = "row needs" if waiting else "row"
    wi_chip = chip(wid) if (wid and src == "tail") else ""
    return (f'<a class="{cls}" href="{seat_url(n)}">{badge}<div class="t"><span class="seat">{h(n)}</span> {h(label)}</div>'
            f'{where_line(s, with_root=src != "where")}'
            f'<div class="x">{h(line)}</div><div class="m">{st_chip(s.get("state"))}<span>{h(detail)}</span>'
            f'{chip(seat_lane(d, s))}{wi_chip}<span>{h(typed)}</span></div></a>')


def thread_row(t, live) -> str:
    chain = t.get("chain") or []
    parts = []
    for c in chain[-4:]:
        n = c.get("n")
        if n in live:
            parts.append(f'<span class="s live">&#9679;{h(n)}</span>')
        else:
            parts.append(f'<span class="s">{h(n)}</span>')
    for l in t.get("live") or []:
        if l.get("n") not in {c.get("n") for c in chain}:
            parts.append(f'<span class="s live">&#9679;{h(l.get("n"))}</span>')
    last = t.get("last") or {}
    lastline = (last.get("type") or "").replace("_", " ")
    if last.get("text"):
        lastline += " · " + last["text"]
    href = "/thread/" + h(t.get("id"))
    return (f'<a class="row" href="{href}"><div class="t">{h(t.get("label"))}</div><div class="x">{h(lastline)}</div>'
            f'<div class="m">{chip(t.get("lane"))}'
            f'<span class="chain">{"<span class=ar>&#8250;</span>".join(parts)}</span><span>{h(t.get("age_days"))}d</span></div></a>')


# ---------------------------------------------------------------- pages

def home(d) -> bytes:
    att = d.get("attention") or []
    live = live_by_n(d)
    seats = sorted(live.values(), key=lambda s: ({"waiting": 0, "working": 1}.get(s.get("state"), 2), s.get("user_min") or 0))
    threads = [t for t in d.get("threads") or [] if t.get("open", True)]
    threads.sort(key=lambda t: t.get("activity") or "", reverse=True)   # most recent activity first
    threads.sort(key=lambda t: 0 if t.get("live") else 1)               # live seats on top (stable)
    # active window (s931): live seat, or last session within ACTIVE_WINDOW of the newest seat
    floor = latest_session_n(d) - ACTIVE_WINDOW

    def _active(t):
        return bool(t.get("live")) or max([c.get("n") or 0 for c in t.get("chain") or []] or [0]) >= floor
    active = [t for t in threads if _active(t)]
    older = [t for t in threads if not _active(t)]
    over = overdue_wis(d)
    b = []
    # "Needs you" band removed (operator, session 954): the Seats band below covers
    # the same attention (waiting/working seats), so it was a duplicate surface.
    # `att` still feeds server-side push; only the visual band is gone.
    cal = calendar_band(d)                       # top of the board, like the desktop panel (s975)
    if cal:
        b.append(cal)
    if over:
        b.append(f'<div class="band"><h2>Overdue <span class="n">{len(over)}</span></h2><div class="card">'
                 + "".join(overdue_row(w) for w in over) + "</div></div>")
    b.extend(surfaces_bands(d))
    # Same rows, same partition as the Seats tab (session 948: the board showed every live
    # transcript while the Seats tab showed only desk panes; the operator read that as two
    # different sets of seats). seats_body() is the one source for both.
    b.append(seats_body(d, getattr(_ctx, "panes", None), title="Seats"))
    tcard = "".join(thread_row(t, live) for t in active) or f'<div class="empty">Nothing touched in the last {ACTIVE_WINDOW} sessions.</div>'
    if older:
        tcard += ('<details class="older"><summary style="padding:12px 14px;color:var(--ink2);font-weight:600;cursor:pointer;border-top:1px solid var(--line)">'
                  f'older <span class="n q" style="background:var(--idle)">{len(older)}</span></summary>'
                  + "".join(thread_row(t, live) for t in older) + "</details>")
    b.append(f'<div class="band"><h2>Threads <span class="n q">{len(active)}</span></h2><div class="card">' + tcard + "</div></div>")
    return _shell("Vault", "".join(b), d, "home")


def seats(d) -> bytes:
    live = sorted(live_by_n(d).values(), key=lambda s: ({"waiting": 0, "working": 1}.get(s.get("state"), 2), -(int(s.get("n") or 0))))
    body = '<div class="band"><div class="card">' + "".join(seat_row(s, d) for s in live) + "</div></div>"
    return _shell("Seats", body, d, "seats")


def seat(d, n, bridge=None, uuid=None) -> bytes:
    s = live_by_n(d).get(int(n)) if str(n).isdigit() else None
    if not s:
        return _shell(f"Seat {n}", f'<div class="band"><div class="card"><div class="empty">Seat {h(n)} is not live.</div></div></div>', d, "seats", back="/")
    t = thread_for_seat(d, n)
    kv = []
    since = ago(s.get("since_min"))
    since = "just now" if since == "now" else f"for {since}"
    kv.append(f'<div class="kv"><div class="k">State</div><div class="v">{st_chip(s.get("state"))} {h(s.get("detail") or "")} · {h(since)} · typed {h(ago(s.get("user_min")))} ago</div></div>')
    if s.get("question"):
        kv.append(f'<div class="kv"><div class="k">Asks</div><div class="v q">{h(s["question"])}</div></div>')
    if s.get("lead"):
        kv.append(f'<div class="kv"><div class="k">Last said</div><div class="v">{h(s["lead"])}</div></div>')
    elif s.get("last_line"):
        kv.append(f'<div class="kv"><div class="k">Last line</div><div class="v">{h(s["last_line"])}</div></div>')
    if s.get("prompt"):
        kv.append(f'<div class="kv"><div class="k">You said</div><div class="v">{h(s["prompt"])}</div></div>')
    if s.get("away"):
        kv.append(f'<div class="kv"><div class="k">While you were away</div><div class="v">{h(s["away"])}</div></div>')
    if s.get("artifacts"):
        items = "".join(f'<div>{obs_file_link(p)} <span style="color:var(--ink2);font-size:13px">{h(p)}</span></div>' for p in s["artifacts"])
        kv.append(f'<div class="kv"><div class="k">Artifacts</div><div class="v">{items}</div></div>')
    if s.get("focus"):
        kv.append(f'<div class="kv"><div class="k">Declared focus</div><div class="v">{h(s["focus"])}</div></div>')
    if s.get("wis"):
        kv.append(f'<div class="kv"><div class="k">Work items</div><div class="v">{wis_links(s["wis"])}</div></div>')
    tail_wis = [w for w in s.get("wis_tail") or [] if w not in (s.get("wis") or [])]
    if tail_wis:
        kv.append(f'<div class="kv"><div class="k">In the transcript</div><div class="v">{wis_links(tail_wis)}</div></div>')
    if (s.get("where") or {}).get("root"):
        kv.append(f'<div class="kv"><div class="k">Working in</div><div class="v">{where_line(s)}</div></div>')
    if t:
        kv.append(f'<div class="kv"><div class="k">Thread</div><div class="v"><a href="/thread/{h(t.get("id"))}" style="color:var(--accent);font-weight:600">{h(t.get("label"))}</a></div></div>')
    b = bridge or s.get("bridge")
    open_link = ""
    if b:
        sid = b[4:] if b.startswith("cse_") else b
        open_link = f'<a class="btn alt" href="https://claude.ai/code/session_{h(sid)}" target="_blank" rel="noopener">Open in Claude</a>'
    reply = f"""
<form id="rf" class="reply"><textarea id="rt" rows="3" placeholder="Reply to seat {h(n)}. Enter sends one prompt, as if typed on the desk."></textarea>
<div class="acts" style="padding:10px 0 0;border:0"><button class="btn" type="submit" id="rb" disabled>Send to seat</button>
<button class="btn alt" type="button" id="fb" disabled>Focus on desk</button>{open_link}</div>
<div id="rs" class="empty" style="padding:8px 0 0">checking the desk…</div></form>
<script>
(function(){{
  var n='{h(n)}', u={json.dumps(uuid or "")}, rs=document.getElementById('rs'), rb=document.getElementById('rb'), fb=document.getElementById('fb'), rt=document.getElementById('rt');
  function say(t){{rs.textContent=t;}}
  fetch('/desk-seats').then(function(r){{return r.json();}}).then(function(list){{
    if(u && list.indexOf(u)>=0){{rb.disabled=false;fb.disabled=false;say('on the desk in a workspace-shell seat');}}
    else{{say('not in a workspace-shell seat on the desk; use Open in Claude');}}
  }}).catch(function(){{say('desk check failed');}});
  function act(k,text){{say(k==='send'?'sending…':'focusing…');
    return fetch('/seat/'+n+'/'+k,{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{text:text||''}})}})
      .then(function(r){{return r.json();}}).then(function(j){{say(j.ok?(k==='send'?'sent, the seat is typing':'focused on the desk'):('failed: '+j.msg));return j.ok;}});}}
  fb.onclick=function(){{act('focus');}};
  document.getElementById('rf').onsubmit=function(e){{e.preventDefault();var t=rt.value.trim();if(!t){{return false;}}
    act('send',t).then(function(ok){{if(ok){{rt.value='';}}}});return false;}};
}})();
</script>"""
    body = (f'<div class="band"><div class="card"><p class="lead"><span class="seat">{h(n)}</span> {h(seat_label(d, s)[0])} {chip(seat_lane(d, s))}</p>'
            + "".join(kv) + f'<div class="kv"><div class="k">Reply</div>{reply}</div></div></div>')
    return _shell(f"Seat {n}", body, d, "seats", back="/")


PUSH_JS = """
<script>
(function(){
  var root=document.currentScript.previousElementSibling, seats=JSON.parse(root.getAttribute('data-seats')||'[]');
  var prefer=root.getAttribute('data-prefer')||'', ta=root.querySelector('textarea'), btn=root.querySelector('.pbtn'), out=root.querySelector('.pout'), sel=null;
  var chips=root.querySelectorAll('.pchip');
  function say(t){out.textContent=t;}
  function choose(n){sel=n;chips.forEach(function(c){c.classList.toggle('on',c.getAttribute('data-n')===String(n));});btn.disabled=!n;btn.textContent=n?('Push to '+n):'Push';}
  chips.forEach(function(c){c.onclick=function(){if(c.classList.contains('off')){say('seat '+c.getAttribute('data-n')+' is not in a workspace-shell pane on the desk');return;}choose(c.getAttribute('data-n'));};});
  fetch('/desk-seat-ns').then(function(r){return r.json();}).then(function(on){
    var first=null;on=on.map(String);
    chips.forEach(function(c){var ok=on.indexOf(c.getAttribute('data-n'))>=0;c.classList.toggle('off',!ok);if(ok&&first===null){first=c.getAttribute('data-n');}
      if(ok&&c.getAttribute('data-n')===prefer){first=prefer;}});
    if(first!==null){choose(first);}else{say(seats.length?'no live seat is in a workspace-shell pane on the desk':'no live seats');}
  }).catch(function(){say('desk check failed');});
  btn.onclick=function(){var t=ta.value.trim();if(!sel||!t){return;}btn.disabled=true;say('pushing to '+sel+'\u2026');
    fetch('/seat/'+sel+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(function(r){return r.json();})
      .then(function(j){btn.disabled=false;say(j.ok?('pushed to seat '+sel+', it is typing'):('failed: '+j.msg));})
      .catch(function(){btn.disabled=false;say('push failed');});};
  ta.addEventListener('input',function(){ta.style.height='auto';ta.style.height=Math.min(220,ta.scrollHeight)+'px';});
})();
</script>"""


def push_block(d, text, prefer=None) -> str:
    """'Push to session n': live seats as chips (greyed when not on the desk), the pickup text
    editable, one button that types it into the chosen seat and presses Enter."""
    live = sorted(live_by_n(d).values(), key=lambda s: -int(s.get("n") or 0))
    seats = [{"n": int(s["n"]), "f": seat_label(d, s)[0][:30], "st": s.get("state") or ""} for s in live]
    chips = "".join(f'<button type="button" class="pchip" data-n="{s["n"]}">'
                    f'<span class="st {h(s["st"])}"></span> {s["n"]} <span class="f">{h(s["f"])}</span></button>' for s in seats)
    return (f'<div class="kv push" data-seats="{h(json.dumps(seats))}" data-prefer="{h(prefer or "")}"><div class="k">Push to a seat</div>'
            f'<div class="pchips">{chips or "<span class=empty style=padding:0>no live seats</span>"}</div>'
            f'<textarea rows="3">{h(text)}</textarea>'
            '<div class="acts" style="padding:8px 0 0;border:0"><button type="button" class="btn pbtn" disabled>Push</button>'
            '<span class="pout" style="font-size:14px;color:var(--ink2)"></span></div></div>' + PUSH_JS)


def thread(d, tid) -> bytes:
    t = next((x for x in (d.get("threads") or []) + (d.get("threads_closed") or []) if x.get("id") == tid), None)
    if not t:
        return _shell("Thread", '<div class="band"><div class="card"><div class="empty">No such thread.</div></div></div>', d, "home", back="/")
    live = live_by_n(d)
    kv = []
    kv.append(f'<div class="kv"><div class="k">Lane</div><div class="v">{chip(t.get("lane"))}'
              + (f' · closed by {h((t.get("closed") or {}).get("by"))}' if t.get("closed") else "")
              + (f'<div style="margin-top:8px">{obs_btn(roadmap_file(t.get("lane")), "Open " + str(t.get("lane")) + " roadmap")}</div>' if t.get("lane") else "")
              + "</div></div>")
    last = t.get("last") or {}
    if last:
        kv.append(f'<div class="kv"><div class="k">Last event · session {h(last.get("n"))} · {h(last.get("date"))}</div>'
                  f'<div class="v"><b>{h((last.get("type") or "").replace("_", " "))}</b> {h(last.get("text"))}'
                  + (f'<div style="color:var(--ink2);margin-top:6px;font-size:15px">{h(last.get("note"))}</div>' if last.get("note") else "") + "</div></div>")
    chain = []
    for c in t.get("chain") or []:
        n = c.get("n")
        ev = ", ".join((e or "").replace("_", " ") for e in c.get("events") or [])
        if n in live:
            chain.append(f'<div><a href="{seat_url(n)}" class="seat">&#9679; {h(n)}</a> <span class="st {h(live[n].get("state"))}">{h(live[n].get("state"))}</span> <span style="color:var(--ink2);font-size:14px">{h(c.get("date"))} · {h(ev)}</span></div>')
        else:
            chain.append(f'<div><span class="mono" style="font-weight:600">{h(n)}</span> <span style="color:var(--ink2);font-size:14px">{h(c.get("date"))} · {h(ev)}</span></div>')
    for l in t.get("live") or []:
        if l.get("n") not in {c.get("n") for c in t.get("chain") or []}:
            chain.append(f'<div><a href="{seat_url(l.get("n"))}" class="seat">&#9679; {h(l.get("n"))}</a> <span class="st {h(l.get("state"))}">{h(l.get("state"))}</span> <span style="color:var(--ink2);font-size:14px">joined: {h(l.get("join"))}</span></div>')
    kv.append(f'<div class="kv"><div class="k">Sessions</div><div class="v">{"".join(chain)}</div></div>')
    rows = t.get("wi_rows") or []
    if rows:
        wr = "".join(f'<div><a href="/wi/{h(r.get("id"))}" class="seat">{h(r.get("id"))}</a> {h(r.get("status"))} · {h(r.get("tasks_done"))}/{h(r.get("tasks_total"))}'
                     + (f' · {h((r.get("delta") or {}).get("summary"))}' if r.get("delta") else "") + "</div>" for r in rows)
        kv.append(f'<div class="kv"><div class="k">Work items</div><div class="v">{wr}</div></div>')
    elif t.get("wis"):
        kv.append(f'<div class="kv"><div class="k">Work items</div><div class="v">{wis_links(t["wis"])}</div></div>')
    on_thread = [c.get("n") for c in (t.get("chain") or []) if c.get("n") in live] + [l.get("n") for l in (t.get("live") or [])]
    kv.append(push_block(d, t.get("pickup") or f"Pick up the thread: {t.get('label')}", prefer=str(on_thread[-1]) if on_thread else None))
    body = f'<div class="band"><div class="card"><p class="lead">{h(t.get("label"))}</p>' + "".join(kv) + "</div></div>"
    return _shell("Thread", body, d, "home", back="/")


def wi(d, wid) -> bytes:
    found = None
    for src in ("clock", "could_do", "blocked_overdue"):
        for r in d.get(src) or []:
            if isinstance(r, dict) and r.get("id") == wid:
                found = found or r
    found = found or wi_index(d).get(wid)
    lane = (found or {}).get("lane")
    kv = []
    if found:
        di = found.get("due_in")
        due_txt = ""
        if found.get("due"):
            due_txt = " · due " + h(found.get("due"))
            if isinstance(di, (int, float)) and di < 0:
                due_txt += f" ({-int(di)}d overdue)"
        nxt = found.get("next_task") or found.get("next")
        kv.append(f'<div class="kv"><div class="k">{h(found.get("status"))}{due_txt}</div>'
                  f'<div class="v">{h(found.get("title"))}</div></div>')
        if found.get("tasks_total") is not None:
            # Real checkboxes, not just a count (operator, session 954: the WI page
            # showed "10 of 19" then a plain list, no boxes). Read the task lines
            # from the roadmap; fall back to the bare count + next-line if the block
            # can't be read (unknown lane, file gone).
            tasks = wi_tasks(lane, wid)
            head = f'{h(found.get("tasks_done"))} of {h(found.get("tasks_total"))}'
            if tasks:
                rows = "".join(
                    f'<div class="chk{" done" if done else ""}">'
                    f'<span class="box">{"&#9745;" if done else "&#9744;"}</span>'
                    f'<span class="ctxt">{h(text)}</span></div>'
                    for done, text in tasks)
                kv.append(f'<div class="kv"><div class="k">Tasks · {head}</div>'
                          f'<div class="v checklist">{rows}</div></div>')
            else:
                kv.append(f'<div class="kv"><div class="k">Tasks</div><div class="v">{head}'
                          + (f' · next: {h(nxt)}' if nxt else "") + "</div></div>")
    refs = [t for t in d.get("threads") or [] if wid in (t.get("wis") or [])]
    if refs:
        kv.append('<div class="kv"><div class="k">Threads</div><div class="v">' + "".join(
            f'<div><a href="/thread/{h(t.get("id"))}" style="color:var(--accent);font-weight:600">{h(t.get("label"))}</a></div>' for t in refs) + "</div></div>")
    seats_ = [s for s in live_by_n(d).values() if wid in (s.get("wis") or []) or wid in (s.get("wis_tail") or [])]
    if seats_:
        kv.append('<div class="kv"><div class="k">Live seats</div><div class="v">' + "".join(
            f'<div><a href="{seat_url(s.get("n"))}" class="seat">&#9679; {h(s.get("n"))}</a> {h(seat_label(d, s)[0])}</div>' for s in seats_) + "</div></div>")
    if found:
        nxt = found.get("next_task") or found.get("next")
        msg = f"Pick up {wid}: {found.get('title') or ''}".rstrip(": ") + "."
        if nxt:
            msg += f" Next task: {nxt}"
        if lane:
            msg += f" Roadmap: {roadmap_file(lane).rsplit('/', 1)[-1]}."
        kv.append(push_block(d, msg, prefer=str(seats_[0].get("n")) if seats_ else None))
    if lane:
        kv.append(f'<div class="kv"><div class="k">Roadmap</div><div class="v">{obs_btn(roadmap_file(lane), "Open " + str(lane) + " roadmap")}</div></div>')
    if not kv:
        kv.append(f'<div class="empty">{h(wid)} is not on any open thread, clock or queue in the current JSON.</div>')
    body = f'<div class="band"><div class="card"><p class="lead"><span class="seat">{h(wid)}</span> {chip(lane)}</p>' + "".join(kv) + "</div></div>"
    return _shell(wid, body, d, "home", back="/")


RESTART_JS = """
<script>
(function(){
  var b=document.getElementById('rsbtn'), s=document.getElementById('rsmsg');
  if(!b){return;}
  b.onclick=function(){
    if(!confirm('Restart the app server? The phone reconnects by itself.')){return;}
    b.disabled=true;s.textContent='restarting';
    fetch('/restart',{method:'POST'}).catch(function(){});
    var t0=Date.now();
    function poll(){
      if(Date.now()-t0>30000){s.textContent='no answer after 30s; launch it from the desk';return;}
      var c=new AbortController();setTimeout(function(){c.abort();},2500);
      fetch('/status.json',{signal:c.signal,cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
        if(j&&j.uptime_s!==undefined&&j.uptime_s<20){s.textContent='back up, pid '+j.pid;setTimeout(function(){location.reload();},600);}
        else{setTimeout(poll,900);}
      }).catch(function(){setTimeout(poll,900);});}
    setTimeout(poll,1500);
  };
})();
</script>"""


def remote_band(r) -> str:
    """The app's own health: server, Tailscale front door, push relay. `r` = serve_tailnet.remote_status()."""
    if not r:
        return ""
    ts = r.get("tailscale") or {}
    push = r.get("push") or {}
    up = r.get("uptime_s")
    upt = ("up " + ago(up / 60)) if up is not None else ""
    backend = ts.get("backend") or "?"
    ts_ok = backend == "Running"
    door_ok = bool(ts.get("serve"))
    door = f"front door: proxy to :{r.get('port')}" if door_ok else "front door: NO serve config"
    health = "".join(f'<div class="x">{h(x)}</div>' for x in (ts.get("health") or [])[:2])
    rows = [
        f'<div class="row"><div class="t">App server</div><div class="x">{h(r.get("url") or "")}</div>'
        f'<div class="m"><span class="st working">running</span><span class="mono">pid {h(r.get("pid"))}</span>'
        f'<span>{h(upt)}</span><span>since {h((r.get("started") or "")[11:16])}</span>'
        f'<span class="r" style="margin-left:auto"><button class="btn alt" id="rsbtn" style="padding:6px 10px;font-size:13px">Restart</button></span></div>'
        f'<div class="m" id="rsmsg"></div></div>',
        f'<div class="row"><div class="t">Tailscale</div>'
        f'<div class="x">{h(ts.get("dns") or "no tailnet name yet")} {h(ts.get("ip") or "")}' + (" · tray app on" if ts.get("gui") else " · tray app not running") + "</div>"
        + health +
        f'<div class="m"><span class="st {"working" if ts_ok else "dead"}">{h(backend)}</span>'
        f'<span class="st {"working" if door_ok else "waiting"}">{h(door)}</span></div></div>',
        f'<div class="row"><div class="t">Push relay</div>'
        f'<div class="x">{h(push.get("last") or "no push sent since the server started")}</div>'
        f'<div class="m"><span>{h(push.get("devices"))} phone(s)</span><span>level {h(push.get("level"))}</span>'
        f'<span>quiet {h(push.get("cooldown_min"))}m</span><a href="/setup" style="color:var(--accent);font-weight:600">Settings</a></div></div>',
    ]
    return (f'<div class="band"><h2>Remote app <span style="margin-left:auto;font-weight:500;text-transform:none;letter-spacing:0">checked {h(r.get("checked"))}</span></h2>'
            f'<div class="card">{"".join(rows)}</div></div>' + RESTART_JS)


def processes(d, proc, remote=None) -> bytes:
    items = (proc or {}).get("processes") or []
    rows = []
    for p in sorted(items, key=lambda x: (x.get("status") != "running", x.get("label") or "")):
        cls = "working" if p.get("status") == "running" else "dead"
        up = p.get("uptime_seconds")
        upt = f"up {ago((up or 0) / 60)}" if up else ""
        port = f"port {p.get('port')}{'' if p.get('port_listening') else ' (not listening)'}" if p.get("port") else ""
        rows.append(f'<div class="row"><div class="t">{h(p.get("label"))}</div><div class="x">{h(p.get("cmd_short") or "")}</div>'
                    f'<div class="m"><span class="st {cls}">{h(p.get("status"))}</span><span class="mono">pid {h(p.get("pid"))}</span>'
                    f'<span>{h(p.get("ram_mb"))} MB</span><span>{h(port)}</span><span>{h(upt)}</span></div></div>')
    when = (proc or {}).get("collected_at") or ""
    try:
        when = datetime.fromtimestamp(float(when)).strftime("%H:%M")
    except Exception:
        when = str(when)[11:16]
    body = (remote_band(remote)
            + f'<div class="band"><h2>Processes · {len(items)} · {h((proc or {}).get("total_ram_mb"))} MB · {h(when)}</h2>'
            f'<div class="card">{"".join(rows) or "<div class=empty>No process status.</div>"}</div></div>')
    return _shell("Processes", body, d, "processes")


SETTINGS_CSS = ('<style>.seg{display:flex;gap:6px}.seg button{flex:1;font:600 15px/1 -apple-system,system-ui,sans-serif;'
                'padding:11px 6px;border-radius:9px;border:1px solid var(--line);background:var(--chip);color:var(--ink2)}'
                '.seg button.on{background:var(--accent);color:#fff;border-color:var(--accent)}'
                '#nmsg{color:var(--work);font-size:13px;font-weight:600}</style>')

NOTIFY_JS = """
<script>
(function(){
  function seg(id,cb){var el=document.getElementById(id);if(!el){return {set:function(){}};}
    el.set=function(v){var kids=el.children;for(var i=0;i<kids.length;i++){kids[i].className=(kids[i].dataset.v==String(v))?'on':'';}};
    var kids=el.children;for(var i=0;i<kids.length;i++){(function(b){b.onclick=function(){el.set(b.dataset.v);cb(b.dataset.v);};})(kids[i]);}
    return el;}
  var msg=document.getElementById('nmsg');
  function flash(t){if(msg){msg.textContent=t;setTimeout(function(){if(msg.textContent===t){msg.textContent='';}},1400);}}
  function apply(j){lvl.set(j.level);cool.set(j.cooldown_min);
    var cr=document.getElementById('ncoolrow');if(cr){cr.style.opacity=(j.level==='off')?'.35':'1';}}
  function save(p){fetch('/notify-prefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    .then(function(r){return r.json();}).then(function(j){apply(j);flash('saved');}).catch(function(){flash('save failed');});}
  var lvl=seg('nlevel',function(v){save({level:v});});
  var cool=seg('ncool',function(v){save({cooldown_min:parseInt(v,10)});});
  fetch('/notify-prefs').then(function(r){return r.json();}).then(apply).catch(function(){});
})();
</script>"""


def setup(d, extra) -> bytes:
    body = (SETTINGS_CSS
            + '<div class="band"><h2>Notifications <span id="nmsg"></span></h2><div class="card">'
            '<div class="kv"><div class="k">Notify me about</div>'
            '<div class="v"><div class="seg" id="nlevel"><button data-v="off">Off</button>'
            '<button data-v="away">Away</button><button data-v="all">Everything</button></div></div></div>'
            '<div class="kv" id="ncoolrow"><div class="k">Quiet window per seat</div>'
            '<div class="v"><div class="seg" id="ncool"><button data-v="5">5 min</button>'
            '<button data-v="20">20 min</button><button data-v="60">60 min</button></div></div></div>'
            '<div class="kv"><div class="k">What each means</div><div class="v"><b>Away</b> = a seat is waiting on you '
            'and you are not already working in it (no pings about a seat you just typed in). <b>Everything</b> also pings '
            'finished work and overdue items. <b>Off</b> = silence. The <b>Seats</b> screen always flags "waiting on you" either way.</div></div>'
            '<div class="kv"><div class="k">This phone</div><div class="v">Enable push once per phone with the bar below; Send test proves the relay.</div></div>'
            '</div></div>'
            '<div class="band"><h2>Views</h2><div class="card">'
            '<div class="kv"><div class="k">Boards</div><div class="v"><a href="/desk" style="color:var(--accent);font-weight:600">Desk-density board</a> (the Obsidian render) · '
            '<a href="/attention" style="color:var(--accent);font-weight:600">Attention + push log</a> (JSON)</div></div>'
            '<div class="kv"><div class="k">Seats</div><div class="v">A seat has an "Open in Claude" button only when it was started with --remote-control.</div></div>'
            '</div></div>'
            + NOTIFY_JS)
    return _shell("Settings", body, d, "setup", extra=extra)


def seat_chat(d, n, uuid=None, on_desk=False) -> bytes:
    """The seat as a conversation: transcript turns + composer + key strip."""
    s = live_by_n(d).get(int(n)) if str(n).isdigit() else None
    if not s:
        return _shell(f"Seat {n}", f'<div class="band"><div class="card"><div class="empty">Seat {h(n)} is not live.</div></div></div>', d, "seats", back="/")
    t = thread_for_seat(d, n)
    kv = []
    if s.get("away"):
        kv.append(f'<div class="kv"><div class="k">While you were away</div><div class="v">{h(s["away"])}</div></div>')
    if s.get("artifacts"):
        items = "".join(f"<div>{h(p.replace(chr(92), '/').rsplit('/', 1)[-1])}</div>" for p in s["artifacts"])
        kv.append(f'<div class="kv"><div class="k">Artifacts</div><div class="v">{items}</div></div>')
    if s.get("focus"):
        kv.append(f'<div class="kv"><div class="k">Declared focus</div><div class="v">{h(s["focus"])}</div></div>')
    if s.get("wis"):
        kv.append(f'<div class="kv"><div class="k">Work items</div><div class="v">{wis_links(s["wis"])}</div></div>')
    tail_wis = [w for w in s.get("wis_tail") or [] if w not in (s.get("wis") or [])]
    if tail_wis:
        kv.append(f'<div class="kv"><div class="k">In the transcript</div><div class="v">{wis_links(tail_wis)}</div></div>')
    if (s.get("where") or {}).get("root"):
        kv.append(f'<div class="kv"><div class="k">Working in</div><div class="v">{where_line(s)}</div></div>')
    if t:
        kv.append(f'<div class="kv"><div class="k">Thread</div><div class="v"><a href="/thread/{h(t.get("id"))}" style="color:var(--accent);font-weight:600">{h(t.get("label"))}</a></div></div>')
    b = s.get("bridge")
    open_link = ""
    if b:
        sid = b[4:] if b.startswith("cse_") else b
        open_link = f'<a class="btn alt" href="https://claude.ai/code/session_{h(sid)}" target="_blank" rel="noopener">Claude</a>'
    kv.append('<div class="kv"><div class="k">Desk</div><div class="v acts" style="padding:6px 0 0;border:0">'
              f'<button type="button" class="btn alt" id="fb">Focus desk</button>{open_link}</div></div>')
    desk_note = "" if on_desk else ('<div class="note">Not in a workspace-shell pane on the desk: reading works, sending will fail.</div>'
                                    + resume_btn(n) + RESUME_JS)
    body = (f'<details class="meta card"><summary>{h(seat_label(d, s)[0])} {chip(seat_lane(d, s))}</summary>{"".join(kv)}</details>'
            + desk_note + '<div id="chat" class="chat"></div>'
            + composer(f"/seat/{h(n)}", "chat", f"Message seat {n}"))
    return _shell(f"Seat {n}", body, d, "seats", back="/seats", current_n=n)   # s948: Back lands on Seats, the page before


def pane(d, leaf, info=None) -> bytes:
    """Any workspace-shell pane (shell, other agent CLIs): screen mirror + composer."""
    info = info or {}
    title = f'{info.get("label") or "Pane"} · {info.get("profile") or "?"}'
    body = (f'<div class="band"><div style="color:var(--ink2);font-size:14px;padding:0 4px">{h(info.get("cwd") or "")}</div></div>'
            '<pre id="scr" class="screen">connecting…</pre>'
            + composer(f"/pane/{h(leaf)}", "screen", "Type a command. Enter sends."))
    return _shell(title, body, d, "seats", back="/seats")


RESUME_JS = """
<script>
document.addEventListener('click',function(e){var b=e.target.closest('.rsm');if(!b){return;}
  var n=b.getAttribute('data-n');b.disabled=true;b.textContent='opening on the desk…';
  fetch('/seat/'+n+'/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json();})
    .then(function(j){if(j.ok){b.textContent='opened, refreshing…';setTimeout(function(){location.reload();},2500);}else{b.disabled=false;b.textContent='Resume on desk';var s=b.nextElementSibling;if(s){s.textContent='failed: '+j.msg;}}})
    .catch(function(){b.disabled=false;b.textContent='Resume on desk';});});
</script>"""


NEW_SEAT_JS = """
<script>
document.addEventListener('click',function(e){var b=e.target.closest('.newseat');if(!b){return;}
  var was=b.textContent;b.disabled=true;b.textContent='opening…';
  fetch('/seats/new',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json();})
    .then(function(j){if(j.ok){b.textContent='opened on the desk';setTimeout(function(){location.href='/seats';},3000);}
      else{b.disabled=false;b.textContent=was;alert('New seat failed: '+j.msg);}})
    .catch(function(){b.disabled=false;b.textContent=was;});});
</script>"""


def resume_btn(n) -> str:
    return (f'<div class="acts"><button type="button" class="btn alt rsm" data-n="{h(n)}">Resume on desk</button>'
            '<span style="font-size:14px;color:var(--ink2)"></span></div>')


def seats_body(d, panes, title="Claude seats") -> str:
    """The seats as ONE partition used by the Seats tab and the board (session 948): seats in a
    workspace-shell pane on the desk first; live transcripts without a pane (the tab was closed,
    the session never stamped closed) fold under "Not on the desk", each with a Resume (s942);
    non-Claude panes last. With no pane info at all (bridge down) every live seat is listed."""
    live = sorted(live_by_n(d).values(), key=lambda s: ({"waiting": 0, "working": 1}.get(s.get("state"), 2), -(int(s.get("n") or 0))))
    if panes is None:
        attached, detached, others = live, [], []
        note = '<div class="note">Desk panes unknown (plugin control socket not answering): every live transcript is listed.</div>'
    else:
        on_desk = desk_ns(panes)
        attached = [s for s in live if int(s.get("n") or 0) in on_desk]
        detached = [s for s in live if int(s.get("n") or 0) not in on_desk]
        others = [p for p in panes if not p.get("n")]
        note = ""
    body = (f'<div class="band"><h2>{h(title)} <span class="n q">{len(attached)}</span>'
            '<button type="button" class="btn alt newseat" style="margin-left:auto;padding:5px 10px;font-size:13px;text-transform:none;letter-spacing:0">+ New seat</button></h2>'
            f'<div class="card">{note}'
            + ("".join(seat_row(s, d) for s in attached) or '<div class="empty">No Claude seat is open on the desk.</div>') + "</div></div>")
    if detached:
        rows = "".join(seat_row(s, d) + resume_btn(s.get("n")) for s in detached)
        body += (f'<details class="meta card"><summary>Not on the desk · {len(detached)} live transcript{"s" if len(detached) != 1 else ""}</summary>'
                 f'{rows}</details>')
    if others:
        rows = "".join(
            f'<a class="row" href="/pane/{h(p.get("leaf"))}"><div class="t">{h(p.get("label") or "Pane")} <span class="chip">{h(p.get("profile") or "?")}</span></div>'
            f'<div class="x">{h(p.get("cwd") or "")}</div><div class="m"><span class="st {"working" if p.get("pty") else "dead"}">{"live" if p.get("pty") else "no pty"}</span>'
            f'<span class="mono">{h(p.get("cols"))} cols</span></div></a>' for p in others)
        body += f'<div class="band"><h2>Other panes on the desk</h2><div class="card">{rows}</div></div>'
    return body + RESUME_JS


def seats_with_panes(d, panes) -> bytes:
    return _shell("Seats", seats_body(d, panes), d, "seats")


def page(kind, d, proc=None, arg=None, extra="", bridge=None, uuid=None, panes=None, on_desk=False, info=None, remote=None) -> bytes:
    _ctx.panes = panes
    if kind == "home":
        return home(d)
    if kind == "seats":
        return seats_with_panes(d, panes)
    if kind == "seat":
        return seat_chat(d, arg, uuid, on_desk)
    if kind == "pane":
        return pane(d, arg, info)
    if kind == "thread":
        return thread(d, arg)
    if kind == "wi":
        return wi(d, arg)
    if kind == "processes":
        return processes(d, proc, remote)
    if kind == "setup":
        return setup(d, extra)
    return home(d)
