const $=id=>document.getElementById(id);let token=location.hash.slice(1),csrf='',help=null,objectURL='',queue=Promise.resolve(),pendingActions=0,dragging=false;history.replaceState(null,'',location.pathname);
let vnc=null,vncId='',connecting=false,clipboardWait=null;
function disconnectDesktop(){clipboardWait?.reject(Error('Desktop disconnected. Select the text again.'));clipboardWait=null;$('copied-text').value='';$('copy-fallback').hidden=true;const previous=vnc;vnc=null;vncId='';previous?.disconnect();$('desktop').replaceChildren();}
async function connectDesktop(id){if(vncId===id&&vnc||connecting)return;connecting=true;try{const {default:RFB}=await import('/novnc/core/rfb.js');if(help?.id!==id)return;disconnectDesktop();const remote=new RFB($('desktop'),`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/vnc?id=${encodeURIComponent(id)}`);vnc=remote;vncId=id;remote.scaleViewport=true;remote.resizeSession=false;remote.viewOnly=false;remote.addEventListener('clipboard',event=>{if(vnc===remote&&clipboardWait?.remote===remote)clipboardWait.resolve(event.detail.text);});remote.addEventListener('connect',()=>status('Live browser connected.'));remote.addEventListener('disconnect',()=>{if(vnc===remote){vnc=null;vncId='';status('Desktop disconnected. Reconnecting if this request is still active.');}});}catch(e){status(e.message);}finally{connecting=false;}}
function key(sym,code=''){vnc?.sendKey(sym,code,true);vnc?.sendKey(sym,code,false);}
const status=t=>$('status').textContent=t;
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Remote-CSRF':csrf},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
function clearFrame(){if(objectURL)URL.revokeObjectURL(objectURL);objectURL='';$('screen').removeAttribute('src');}
async function state(){const data=await api('/api/state');csrf=data.csrf;if(help?.id!==data.help?.id){disconnectDesktop();clearFrame();$('text').value='';}help=data.help;$('inbox').hidden=false;$('unlock').hidden=true;$('controls').hidden=!help;$('request').textContent=help?`${help.source} needs your help`:'Nothing needs your attention.';$('instruction').textContent=help?`${help.reason}. Complete the login or verification below, then tap Done.`:'You will get an email when a search needs your help.';$('url').textContent=help?.url||'';$('desktop').hidden=help?.transport!=='novnc';$('viewport').hidden=help?.transport==='novnc';$('copy-text').disabled=help?.transport!=='novnc';if(help?.transport==='novnc')await connectDesktop(help.id);}
function run(fn){pendingActions++;queue=queue.then(async()=>{try{status('');await fn();}catch(e){status(e.message);}finally{pendingActions--;}});return queue;}
$('unlock').onclick=()=>run(async()=>{await api('/api/redeem',{token});token='';await state();});
const action=payload=>{if(help?.transport==='novnc'){
 if(!vnc){status('Wait for the desktop connection.');return;}
 if(payload.kind==='text'){return run(async()=>{const remote=vnc;for(const c of payload.text){if(vnc!==remote||!remote)throw Error('Desktop disconnected during typing. Check the field before retrying.');const cp=c.codePointAt(0);key(cp<=255?cp:0x01000000+cp);await new Promise(resolve=>setTimeout(resolve,50));}});}
 else if(payload.kind==='key'){if(payload.key==='ControlOrMeta+A'){vnc.sendKey(0xffe3,'ControlLeft',true);key(97,'KeyA');vnc.sendKey(0xffe3,'ControlLeft',false);}else key({Enter:0xff0d,Tab:0xff09,Backspace:0xff08,Escape:0xff1b}[payload.key]);}
 else if(payload.kind==='reload'){vnc.sendKey(0xffe3,'ControlLeft',true);key(114,'KeyR');vnc.sendKey(0xffe3,'ControlLeft',false);}
 else if(payload.kind==='back'){vnc.sendKey(0xffe9,'AltLeft',true);key(0xff51,'ArrowLeft');vnc.sendKey(0xffe9,'AltLeft',false);}
 else if(payload.kind==='scroll')key(payload.dy>0?0xff56:0xff55,payload.dy>0?'PageDown':'PageUp');
 return;}
 const id=help?.id;if(id)return run(()=>api('/api/action',{id,payload}));};
document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>action({kind:b.dataset.kind}));document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>action({kind:'key',key:b.dataset.key}));document.querySelectorAll('[data-scroll]').forEach(b=>b.onclick=()=>action({kind:'scroll',dy:Number(b.dataset.scroll)}));
$('typing').onsubmit=e=>{e.preventDefault();const text=$('text').value;$('text').value='';action({kind:'text',text});};
for(const [button,skip]of [['done',false],['skip',true]])$(button).onclick=()=>{const id=help?.id;if(!id)return;run(async()=>{await api('/api/finish',{id,payload:{skip}});help=null;disconnectDesktop();clearFrame();$('controls').hidden=true;status(skip?'Request skipped. Search is continuing.':'Thanks. Search is continuing.');await state();});};
let lastMove=0;function pointer(e,phase){const r=$('screen').getBoundingClientRect();action({kind:'pointer',phase,x:Math.max(0,Math.min(1023,(e.clientX-r.left)*1024/r.width)),y:Math.max(0,Math.min(767,(e.clientY-r.top)*768/r.height))});}
$('screen').onpointerdown=e=>{if(!help)return;e.preventDefault();dragging=true;$('screen').setPointerCapture(e.pointerId);pointer(e,'down');};$('screen').onpointermove=e=>{if(dragging&&Date.now()-lastMove>80){lastMove=Date.now();pointer(e,'move');}};for(const name of ['onpointerup','onpointercancel'])$('screen')[name]=e=>{if(dragging){dragging=false;pointer(e,'up');}};
async function refresh(){try{if(!pendingActions&&!dragging&&!document.hidden){await state();const id=help?.id;if(id&&help.transport!=='novnc'){const r=await fetch(`/api/frame?id=${encodeURIComponent(id)}`);if(r.ok){const blob=await r.blob();if(help?.id===id){const next=URL.createObjectURL(blob);const preview=new Image();preview.src=next;try{await preview.decode();if(help?.id===id){const previous=objectURL;objectURL=next;$('screen').src=next;if(previous)URL.revokeObjectURL(previous);}else URL.revokeObjectURL(next);}catch{URL.revokeObjectURL(next);}}}}}}catch(e){status(e.message);}finally{setTimeout(refresh,1500);}}
refresh();

$('copy-text').onclick=async()=>{
 if(!vnc){status('Connect to the desktop and select the text first.');return;}
 if(clipboardWait){status('Waiting for the selected text…');return;}
 if(pendingActions){status('Wait for typing to finish, then copy.');return;}
 const remote=vnc,id=help?.id;let timer;
 const selected=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('No copied text received. Select text in the remote browser, then try again.')),6000);clipboardWait={remote,resolve,reject};});
 // Start the phone clipboard operation inside the tap, before waiting for VNC.
 const write=navigator.clipboard?.write&&typeof ClipboardItem!=='undefined'?navigator.clipboard.write([new ClipboardItem({'text/plain':selected.then(text=>new Blob([text],{type:'text/plain'}))})]).then(()=>true,()=>false):Promise.resolve(false);
 status('Copying selected text…');$('copy-fallback').hidden=true;$('copied-text').value='';
 remote.sendKey(0xffe3,'ControlLeft',true);key(99,'KeyC');remote.sendKey(0xffe3,'ControlLeft',false);
 try{const text=await selected;if(vnc!==remote||help?.id!==id)return;
 if(await write){status('Copied to your phone clipboard.');}
 else{$('copied-text').value=text;$('copy-fallback').hidden=false;status('Text is ready. Tap Copy to phone, or select the text below.');}
 }catch(e){status(e.message);}finally{clearTimeout(timer);clipboardWait=null;}
};
$('copy-phone').onclick=async()=>{try{await navigator.clipboard.writeText($('copied-text').value);status('Copied to your phone clipboard.');$('copied-text').value='';$('copy-fallback').hidden=true;}catch{$('copied-text').focus();$('copied-text').select();status('Touch and hold the selected text, then choose Copy.');}};
