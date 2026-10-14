import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedApprovalNotice, hostedApprovalResponse, hostedApprovalPage } from '../dist/server/managed/hosted-approval.js';
const auth = {type:'computer_use_approval_request',request_id:'request-one',turn_id:'turn-one',request:{type:'browser_authentication',credential_origin:'https://account.example.com',reason:'Sign in',fields:[
 {id:'email',label:'Email',required:true,type:'email'}, {id:'password',label:'Password',required:true,type:'password'}, {id:'otp',label:'Code',required:true,type:'text'}
],options:[{id:'login',label:'Password login',field_ids:['email','password']},{id:'code',label:'Verification code',field_ids:['otp']}]}};
test('browser notices distinguish website approval from sign-in without exposing private fields',()=>{
 const link='https://app.example.com/agent-access/original';
 const origin={...auth,request:{type:'browser_origin_access',origin:'https://hitcents.com',reason:'untrusted provider reason'}};
 const notice=hostedApprovalNotice(origin,link);
 assert.match(notice,/approval to open https:\/\/hitcents.com/);
 assert.ok(notice.includes(`[Review website access](${link})`));
 assert.match(notice,/continue your original request/);
 assert.doesNotMatch(notice,/password|verification code|sign-in|untrusted provider reason|request-one|turn-one/);
 const login=hostedApprovalNotice(auth,link);
 assert.match(login,/https:\/\/account.example.com needs you to complete sign-in/);
 assert.match(login,/Do not send passwords or verification codes in chat/);
 assert.doesNotMatch(login,/field_ids|request-one|turn-one/);
 for(const value of ['https://user:private@example.com/path?secret=private','javascript:private','not-a-url']) {
  const result=hostedApprovalNotice({...origin,request:{...origin.request,origin:value}},link);
  assert.ok(result.includes('the requested website'));assert.ok(!result.includes(value));
 }
 assert.ok(!hostedApprovalNotice({...auth,request:{...auth.request,credential_origin:'https://account.example.com/path?secret=value'}},link).includes('secret=value'));
});
test('private form submits exact registered option/field identities without inactive fields',()=>{
 const result=hostedApprovalResponse(auth,{action:'submit',option:'code',field_0:'unused',field_1:'not-sent',field_2:'one-time-code'});
 assert.deepEqual(result,{type:'agent.session.input.computer_use_approval_request_result',request_id:'request-one',response:{type:'browser_authentication',action:'submit',selected_option:'code',fields:[{field_id:'otp',value:'one-time-code'}]}});
 assert.throws(()=>hostedApprovalResponse(auth,{action:'submit',option:'invented'}));
 assert.throws(()=>hostedApprovalResponse(auth,{action:'submit',option:'login',field_0:'email-only'}));
 assert.throws(()=>hostedApprovalResponse(auth,{action:'submit',option:'code',field_2:{secret:'object'}}));
});
test('cancel and origin decisions require explicit submitted values',()=>{
 assert.equal(hostedApprovalResponse(auth,{action:'cancel'}).response.action,'cancel');
 const origin={...auth,request:{type:'browser_origin_access',origin:'https://example.com',reason:null}};
 for(const decision of ['approve','deny','cancel'])assert.equal(hostedApprovalResponse(origin,{decision}).response.decision,decision);
 assert.throws(()=>hostedApprovalResponse(origin,{}));
 assert.throws(()=>hostedApprovalResponse(origin,{decision:true}));
});
test('provider-supplied labels and origins are escaped; saved credentials are never rendered',()=>{
 const action=structuredClone(auth);action.request.reason='<script>bad</script>';action.request.fields[0].label='<img onerror="bad">';
 const html=hostedApprovalPage({action,csrf:'csrf',path:'/private/access',nonce:'nonce',accounts:[{ref:'account-ref',label:'Family account'}]});
 assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
 assert.ok(html.includes('name="source_0"'));assert.ok(html.includes('Saved username'));assert.ok(html.includes('Family account'));
 assert.ok(html.includes('name="option" value="code"'));assert.ok(!html.includes('localhost'));
});
