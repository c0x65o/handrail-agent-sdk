import {createHash} from 'node:crypto';
import type {AgentSessionItem} from 'openai/resources/beta/agents/agents';

export interface HostedScreenshot {
  sessionId:string; turnId:string; itemId:string; filename:string;
  contentType:'image/png'|'image/jpeg'; data:Uint8Array; sha256:string;
}
/** Screenshots are live computer-use outputs, not published environment files.
 * Saved item history can omit their bytes. Retain them at the stream boundary
 * with the original runtime-supplied session/turn; a metadata-only replay must
 * never erase the image already held by the application. No URL is fetched. */
export function readHostedScreenshot(item:AgentSessionItem, origin:{sessionId:string;turnId:string},maxBytes:number):HostedScreenshot|null {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('HOSTED_SCREENSHOT_CAPACITY_INVALID');
  if(item.type!=='computer_use_call'||!item.output?.image_url)return null;
  if(!origin.sessionId||!origin.turnId||item.turn_id!==origin.turnId||item.status!=='completed')throw Error('HOSTED_SCREENSHOT_SCOPE_CONFLICT');
  const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.output.image_url);
  if(!match||match[2]!.length>Math.ceil(maxBytes/3)*4)throw Error('HOSTED_SCREENSHOT_INVALID');
  const data=Buffer.from(match[2]!,'base64');
  if(!data.length||data.length>maxBytes||data.toString('base64')!==match[2])throw Error('HOSTED_SCREENSHOT_INVALID');
  const png=match[1]==='png';
  if(png?!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    data.length<3||data[0]!==255||data[1]!==216||data[2]!==255)throw Error('HOSTED_SCREENSHOT_INVALID');
  return {...origin,itemId:item.id,filename:`browser-${createHash('sha256').update(item.id).digest('hex').slice(0,16)}.${png?'png':'jpg'}`,
    contentType:png?'image/png':'image/jpeg',data,sha256:createHash('sha256').update(data).digest('hex')};
}
