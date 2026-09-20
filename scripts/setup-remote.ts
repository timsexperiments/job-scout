import { randomBytes } from "node:crypto";
import { read,save } from "../src/io.ts";
import { SetupConfig,hashToken } from "../src/setup-auth.ts";
const previous=await read("data/mail-setup/config.json",SetupConfig);
const token=randomBytes(32).toString("base64url");
const config={...previous,port:4319,tokenHash:hashToken(token),consumed:false,expiresAt:Date.now()+86400000};
await save("data/remote-browser/config.json",config);
process.stdout.write(JSON.stringify({url:`https://${config.address}:4319/#${token}`,expiresAt:new Date(config.expiresAt).toISOString(),fingerprint:config.fingerprint})+"\n");
