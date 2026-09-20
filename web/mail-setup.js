let magic=location.hash.slice(1), csrf='';
history.replaceState(null,'','/');
const status=document.querySelector('#status'), unlock=document.querySelector('#unlock-button'), form=document.querySelector('#settings');
async function post(path,body) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-Setup-CSRF':csrf}:{})},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data;
}
function showForm() {document.querySelector('#unlock').hidden=true;form.hidden=false;status.textContent='Private setup unlocked.';}
unlock.addEventListener('click',async()=>{
  unlock.disabled=true;
  try {const data=await post('/api/redeem',{token:magic});magic='';csrf=data.csrf;showForm();}
  catch(error){status.textContent=error.message;unlock.disabled=false;}
});
form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Testing Google SMTP…';
  const fields=new FormData(form);const password=form.elements.namedItem('appPassword');
  try {const data=await post('/api/save',{email:fields.get('email'),appPassword:fields.get('appPassword')});password.value='';form.hidden=true;status.textContent=data.message;}
  catch(error){password.value='';status.textContent=error.message;button.disabled=false;}
});
if(!magic)fetch('/api/status').then(async response=>{if(response.ok){const data=await response.json();csrf=data.csrf;showForm();}else status.textContent='Open the private link provided in your chat.';}).catch(()=>{status.textContent='Could not connect to the local setup service.';});
