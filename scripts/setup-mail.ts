import { mkdir, chmod } from "node:fs/promises";
import { randomBytes, X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import { SetupConfig, hashToken } from "../src/setup-auth.ts";
import { root, save } from "../src/io.ts";
const address=process.argv[2], netmask=process.argv[3];
if (!address || !netmask || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) throw new Error("Usage: bun scripts/setup-mail.ts PRIVATE_LAN_IP NETMASK");
const directory=resolve(root,"data/mail-setup");await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
const key=resolve(directory,"key.pem"),cert=resolve(directory,"cert.pem");
// Validate inputs before using them in certificate arguments. No shell is used.
SetupConfig.pick({address:true,netmask:true}).parse({address,netmask});
const processTLS=Bun.spawn(["openssl","req","-x509","-newkey","rsa:2048","-sha256","-nodes","-keyout",key,"-out",cert,"-days","30","-subj","/CN=Job Scout LAN Setup","-addext",`subjectAltName=IP:${address}`],{stdout:"ignore",stderr:"ignore"});
if (await processTLS.exited) throw new Error("Unable to generate the local TLS certificate");
await chmod(key,0o600);await chmod(cert,0o600);
const fingerprint=new X509Certificate(await Bun.file(cert).text()).fingerprint256;
const token=randomBytes(32).toString("base64url");
const config=SetupConfig.parse({address,netmask,port:4318,tokenHash:hashToken(token),expiresAt:Date.now()+24*3600000,consumed:false,fingerprint});
await save("data/mail-setup/config.json",config);
// Only this explicitly invoked setup command emits the link. It is never saved.
process.stdout.write(JSON.stringify({url:`https://${address}:4318/#${token}`,expiresAt:new Date(config.expiresAt).toISOString(),fingerprint})+"\n");
