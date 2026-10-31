import * as NodeCrypto from "node:crypto";

// A fresh capability for the app process; it is not a backend bearer token.
export const WSL_DIRECT_HOST = `wsl-${NodeCrypto.randomBytes(24).toString("hex")}`;
