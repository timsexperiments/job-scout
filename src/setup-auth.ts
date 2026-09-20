import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { z } from "zod";
export const SetupConfig=z.object({address:z.ipv4(),netmask:z.ipv4(),port:z.number().int().min(1024).max(65535),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number(),consumed:z.boolean(),fingerprint:z.string()});
export type SetupConfig=z.infer<typeof SetupConfig>;
export const hashToken=(value:string)=>createHash("sha256").update(value).digest("hex");
export function tokenMatches(token:string,config:SetupConfig,now=Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || config.consumed || now>=config.expiresAt) return false;
  return timingSafeEqual(Buffer.from(hashToken(token),"hex"),Buffer.from(config.tokenHash,"hex"));
}
const ipNumber=(value:string)=>value.split(".").reduce((sum,part)=>(sum*256+Number(part))>>>0,0);
export function sameSubnet(peer:string,address:string,mask:string) {
  peer=peer.replace(/^::ffff:/,"");
  if (!z.ipv4().safeParse(peer).success) return false;
  return (ipNumber(peer)&ipNumber(mask))===(ipNumber(address)&ipNumber(mask));
}
export class SetupSessions {
  private sessions=new Map<string,{expires:number;csrf:string}>();
  create(now=Date.now()) { const token=randomBytes(32).toString("base64url"), csrf=randomBytes(32).toString("base64url");this.sessions.set(hashToken(token),{expires:now+30*60000,csrf});return {token,csrf}; }
  get(token:string,now=Date.now()) {const key=hashToken(token),session=this.sessions.get(key);if (!session || now>=session.expires) {this.sessions.delete(key);return null;}return session;}
  revoke(token:string) {this.sessions.delete(hashToken(token));}
}
