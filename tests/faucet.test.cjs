const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const uuid = '4fa71734-cd16-47f9-a0fe-318633c92e11';
const params = () => ({ 'CC Amount': '100', PartyID: 'test-validator::1220abcdef', Usage: '', request_id: uuid });

function backend() {
  const state = { rows: [], mails: [], props: new Map([['MONDAY_API_TOKEN', 'test-only']]), failCreate: false, failMail: false, activeEmail: 'amanda@canton.foundation', triggers: [] };
  const properties = { getProperty: k => state.props.get(k) || null, setProperty: (k,v) => state.props.set(k,String(v)), deleteProperty: k => state.props.delete(k), setProperties: obj => Object.entries(obj).forEach(([k,v])=>state.props.set(k,String(v))) };
  const context = vm.createContext({
    console: {error() {}}, Logger: {log() {}},
    Utilities: {getUuid: () => uuid}, PropertiesService: {getScriptProperties: () => properties},
    LockService: {getScriptLock: () => ({tryLock:()=>true,releaseLock(){}})},
    Session: {getActiveUser: () => ({getEmail:()=>state.activeEmail})},
    MailApp: {sendEmail: mail => {if(state.failMail) throw Error('Temporary mail failure');state.mails.push(mail);}},
    HtmlService: {XFrameOptionsMode:{ALLOWALL:'all'},createHtmlOutput:html=>({setXFrameOptionsMode(){return this;},getContent:()=>html})},
    ScriptApp: {getProjectTriggers:()=>state.triggers,newTrigger:name=>({timeBased(){return this;},everyMinutes(n){assert.equal(n,15);return this;},create(){state.triggers.push({getHandlerFunction:()=>name});}})}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8'),context);
  const c = vm.runInContext('FAUCET.columns',context);
  const cells = row => Object.entries(row.values).map(([id,v])=>({id,text:typeof v==='object'?(v.label || v.text || v.date || ''):String(v),value:JSON.stringify(v)}));
  context.faucetMonday_ = (query,vars) => {
    if(query.includes('items_page_by_column_values'))return {items_page_by_column_values:{items:state.rows.filter(r=>r.values[c.requestId]===vars.id).map(r=>({id:r.id,column_values:cells(r)}))}};
    if(query.includes('create_item')) {
      if(state.failCreate)throw Error('Private API failure details');
      const row={id:String(state.rows.length+1),values:JSON.parse(vars.values),group:vars.g,updated_at:new Date().toISOString()};state.rows.push(row);return {create_item:{id:row.id}};
    }
    if(query.includes('change_multiple_column_values')){const row=state.rows.find(r=>r.id===vars.id);Object.assign(row.values,JSON.parse(vars.v));return {change_multiple_column_values:{id:row.id}};}
    if(query.includes('boards'))return {boards:[{id:'18438203163',name:'TestNet Faucet Requests',columns:Object.values(c).map(id=>({id})),groups:[{id:'topics'},{id:'group_mm8rkc2b'}],items_page:{cursor:null,items:state.rows.map(r=>({id:r.id,updated_at:r.updated_at,column_values:cells(r)}))}}]};
    throw Error('Unexpected query');
  };
  const reply = p => {
    const html=context.doPost({parameter:p}).getContent();
    const start=html.indexOf('postMessage(')+'postMessage('.length;
    const end=html.indexOf(',"https://testnet-faucet.canton.foundation"',start);
    return JSON.parse(html.slice(start,end));
  };
  return {state,context,c,reply};
}

test('valid submission saves to Monday before success and sends the existing notification',()=>{
  const h=backend();const result=h.reply(params());
  assert.equal(result.success,true);assert.equal(h.state.rows.length,1);
  const v=h.state.rows[0].values;
  assert.equal(v[h.c.party],params().PartyID);assert.equal(v[h.c.amount],'100');
  assert.equal(v[h.c.status].label,'New');assert.equal(v[h.c.source],'Website');
  assert.equal(v[h.c.notification].label,'Sent');assert.equal(h.state.mails.length,1);
  assert.equal(h.state.mails[0].to,'amanda@canton.foundation');
  assert.match(h.state.mails[0].body,/monday\.com\/boards\/18438203163\/pulses\/1/);
  assert.doesNotMatch(h.state.mails[0].body,/airtable/i);
});

test('retries with the same ID do not create another request or send another email',()=>{
  const h=backend();assert.equal(h.reply(params()).success,true);assert.equal(h.reply(params()).success,true);
  assert.equal(h.state.rows.length,1);assert.equal(h.state.mails.length,1);
  const changed=h.reply({...params(),'CC Amount':'200'});
  assert.equal(changed.success,false);assert.match(changed.message,/different details/);
  assert.equal(h.state.rows.length,1);
});

test('server enforces the existing amount and justification rules',()=>{
  for(const amount of ['0','-1','1.5','abc','9007199254740992']) {
    const h=backend();assert.equal(h.reply({...params(),'CC Amount':amount}).success,false);assert.equal(h.state.rows.length,0);
  }
  const h=backend();assert.equal(h.reply({...params(),'CC Amount':'1001'}).success,false);
  assert.equal(h.reply({...params(),'CC Amount':'1001',Usage:'Validator load testing'}).success,true);
});

test('invalid PartyIDs, oversized input, bot fields, and bad IDs are rejected before persistence',()=>{
  for(const bad of [{PartyID:''},{PartyID:'x\nattack'},{PartyID:'x'.repeat(513)},{Usage:'x'.repeat(10001)},{website:'https://bot.example'},{request_id:'bad-id'}]) {
    const h=backend();assert.equal(h.reply({...params(),...bad}).success,false);assert.equal(h.state.rows.length,0);
  }
});

test('a Monday write failure never reports success or sends a notification',()=>{
  const h=backend();h.state.failCreate=true;const result=h.reply(params());
  assert.equal(result.success,false);assert.equal(h.state.rows.length,0);assert.equal(h.state.mails.length,0);
  assert.doesNotMatch(result.message,/Private API/);
});

test('notification failure preserves the request and is retried without duplicating it',()=>{
  const h=backend();h.state.failMail=true;assert.equal(h.reply(params()).success,true);
  assert.equal(h.state.rows[0].values[h.c.notification].label,'Failed');
  h.state.failMail=false;h.context.retryFaucetNotifications_();
  assert.equal(h.state.rows.length,1);assert.equal(h.state.mails.length,1);
  assert.equal(h.state.rows[0].values[h.c.notification].label,'Sent');
});

test('one-use authorized QA is isolated, while client test flags do not suppress real requests',()=>{
  const h=backend();h.state.props.set('FAUCET_QA_ID',uuid);h.state.props.set('FAUCET_QA_EXPIRES',String(Date.now()+600000));
  assert.equal(h.reply(params()).success,true);assert.equal(h.state.rows[0].group,'group_mm8rkc2b');
  assert.equal(h.state.rows[0].values[h.c.status].label,'Ignoring');assert.equal(h.state.mails.length,0);assert.equal(h.state.props.has('FAUCET_QA_ID'),false);
  const normal=backend();assert.equal(normal.reply({...params(),test:'true',suppressNotifications:'true'}).success,true);
  assert.equal(normal.state.mails.length,1);
});

test('administrative entry points reject anonymous users and installation is idempotent',()=>{
  const h=backend();h.state.activeEmail='';
  for(const name of ['verifyFaucetSetup','installFaucetAutomation','prepareFaucetWebTest'])assert.throws(()=>h.context[name](),/administrator/);
  h.state.activeEmail='amanda@canton.foundation';h.context.installFaucetAutomation();h.context.installFaucetAutomation();assert.equal(h.state.triggers.length,1);
});

test('HTML acknowledgements cannot inject submitted text into scripts',()=>{
  const h=backend();const html=h.context.faucetReply_({success:false,requestId:'</script><img onerror=alert(1)>'}).getContent();
  assert.doesNotMatch(html,/<img/);assert.match(html,/\\u003c\/script>/);
});

function frontend() {
  const elements={};const callbacks={};let timer;
  const ids=['testnet-faucet-form','cc_amount','usage','cc-warning','submit-request','submit-error','request-id','form-shell','thank-you-message'];
  for(const id of ids)elements[id]={style:{},value:'',hidden:true,disabled:false,textContent:'',events:{},addEventListener(name,fn){this.events[name]=fn;},setAttribute(){},removeAttribute(){},checkValidity(){return !elements.usage.required || !!elements.usage.value;}};
  elements.cc_amount.value='100';
  const window={location:{search:''},crypto:{randomUUID:()=>uuid},setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){timer=null;},addEventListener:(name,fn)=>callbacks[name]=fn,scrollTo(){}};
  const context=vm.createContext({window,document:{getElementById:id=>elements[id]},URL,URLSearchParams});
  vm.runInContext(fs.readFileSync(path.join(root,'faucet-form.js'),'utf8'),context);
  const submit=()=>{const event={prevented:false,preventDefault(){this.prevented=true;}};elements['testnet-faucet-form'].events.submit(event);return event;};
  const message=(data,origin='https://n-example-0lu-script.googleusercontent.com')=>callbacks.message({data:{type:'canton-faucet-result',requestId:uuid,...data},origin});
  return {elements,submit,message,timeout:()=>timer()};
}

test('form waits for a matching trusted acknowledgement before showing thanks',()=>{
  const h=frontend();h.submit();assert.equal(h.elements['submit-request'].disabled,true);assert.notEqual(h.elements['form-shell'].style.display,'none');
  h.message({success:true},'https://attacker.example');h.message({success:true,requestId:'different'});
  assert.notEqual(h.elements['form-shell'].style.display,'none');assert.equal(h.submit().prevented,true);
  h.message({success:true});assert.equal(h.elements['form-shell'].style.display,'none');assert.equal(h.elements['thank-you-message'].style.display,'block');
});

test('failed and timed-out submissions retain their ID and data for safe retry',()=>{
  const h=frontend();h.elements.usage.value='keep my details';h.submit();h.message({success:false,message:'Please try again.'});
  assert.equal(h.elements['submit-error'].hidden,false);assert.equal(h.elements['submit-request'].disabled,false);assert.equal(h.elements.usage.value,'keep my details');
  h.submit();h.timeout();assert.equal(h.elements['request-id'].value,uuid);assert.equal(h.elements['submit-request'].disabled,false);assert.notEqual(h.elements['form-shell'].style.display,'none');
});

test('amounts over 1000 still require justification in the browser',()=>{
  const h=frontend();h.elements.cc_amount.value='1001';h.elements.cc_amount.events.input();
  assert.equal(h.elements.usage.required,true);assert.equal(h.submit().prevented,true);
});
