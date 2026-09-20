const views = new Map();
const node = (tag,text) => { const el=document.createElement(tag); if(text!==undefined)el.textContent=text; return el; };
export function mountDraftChat(container,id,draft,{api,onUpdated}) {
 const view=views.get(id)??{questionIndex:null,open:false};views.set(id,view);
 const panel=node('details');panel.className='draft-chat';panel.open=view.open;
 panel.append(node('summary','Chat about this application'));
 panel.addEventListener('toggle',()=>{view.open=panel.open;});
 const intro=node('p','Ask for a revision or check an experience claim. Résumé lookups use your local cache. Changes are saved with version history.');panel.append(intro);
 const scope=node('select');scope.id='chat-question';scope.setAttribute('aria-label','Question to revise');
 const whole=node('option','Whole application');whole.value='';scope.append(whole);
 draft.answers.forEach((answer,index)=>{const option=node('option',answer.question);option.value=String(index);scope.append(option);});
 scope.value=view.questionIndex===null?'':String(view.questionIndex);scope.onchange=()=>{view.questionIndex=scope.value===''?null:Number(scope.value);};panel.append(scope);
 const history=node('div');history.className='chat-history';history.setAttribute('aria-live','polite');panel.append(history);
 const form=node('form'),input=node('textarea');input.id='chat-message';input.rows=3;input.maxLength=4000;input.required=true;input.placeholder='For example: Shorten this answer and use my data-masking experience.';input.setAttribute('aria-label','Message to the application editor');
 const send=node('button','Send');send.type='submit';send.className='primary';const status=node('p');status.id='chat-status';status.setAttribute('role','status');
 form.append(input,send,status);panel.append(form);
 const versions=node('select');versions.setAttribute('aria-label','Earlier draft version');
 const restore=node('button','Restore version');restore.type='button';const versionBox=node('details');versionBox.append(node('summary','Earlier versions'),versions,restore);panel.append(versionBox);container.append(panel);
 let state=null,disposed=false;
 async function refresh(){
  if(!panel.isConnected){disposed=true;return;}
  try{
   const next=await api(`/api/draft/${id}/chat`);
   if(!panel.isConnected)return;
   if(state && next.revision!==state.revision){await onUpdated();return;}
   state=next;history.replaceChildren();
   for(const turn of next.turns.slice(-12)){
    const item=node('article');item.append(node('strong','You'),node('p',turn.user));
    if(turn.questionIndex!==null)item.append(node('small',draft.answers[turn.questionIndex]?.question??'Selected question'));
    if(turn.tools.length){const tools=node('details');tools.append(node('summary','Evidence checked'),node('p',turn.tools.join(' · ')));item.append(tools);}
    item.append(node('strong','Job Scout'),node('p',turn.state==='running'?'Checking the draft and résumé evidence…':turn.state==='failed'?turn.error:turn.reply));
    if(turn.state==='done')for(const change of turn.changes){const diff=node('details');diff.append(node('summary',`Changed: ${change.question}`),node('h4','Before'),node('p',change.before||'Blank'),node('h4','After'),node('p',change.after||'Blank'));item.append(diff);}
    history.append(item);
   }
   const busy=next.turns.some(turn=>turn.state==='running');send.disabled=busy;input.disabled=busy;scope.disabled=busy;restore.disabled=busy||!next.versions.length;
   status.textContent=busy?'Working locally. You can close this draft and return.':'';
   versions.replaceChildren();for(const version of [...next.versions].reverse()){const option=node('option',`${new Date(version.createdAt).toLocaleString()} — ${version.label}`);option.value=version.id;versions.append(option);}
   if(busy&&!disposed)setTimeout(refresh,2000);
  }catch(error){status.textContent=error.message;send.disabled=false;input.disabled=false;}
 }
 form.onsubmit=async event=>{
  event.preventDefault();if(!state||!input.value.trim())return;
  send.disabled=true;status.textContent='Sending…';
  try{await api(`/api/draft/${id}/chat`,{message:input.value.trim(),revision:state.revision,questionIndex:view.questionIndex});input.value='';await refresh();}
  catch(error){status.textContent=error.message;send.disabled=false;}
 };
 restore.onclick=async()=>{if(!state||!versions.value)return;restore.disabled=true;try{await api(`/api/draft/${id}/restore`,{versionId:versions.value,revision:state.revision});await onUpdated();}catch(error){status.textContent=error.message;restore.disabled=false;}};
 queueMicrotask(()=>{void refresh();});
 return {focus(index){view.questionIndex=index;view.open=true;scope.value=String(index);panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});input.focus();}};
}
