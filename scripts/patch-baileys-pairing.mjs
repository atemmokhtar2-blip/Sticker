import fs from "node:fs";
import path from "node:path";

const pnpmStore = path.resolve(process.cwd(), "node_modules/.pnpm");
if (!fs.existsSync(pnpmStore)) {
  throw new Error("pnpm package store was not found; Baileys pairing patch was not applied");
}

const packageDirs = fs.readdirSync(pnpmStore).filter((name) =>
  name.startsWith("@whiskeysockets+baileys@7.0.0-rc13")
);
if (packageDirs.length === 0) {
  throw new Error("Expected @whiskeysockets/baileys 7.0.0-rc13 was not installed");
}

let patchedCount = 0;
for (const packageDir of packageDirs) {
  const socketFile = path.join(
    pnpmStore,
    packageDir,
    "node_modules/@whiskeysockets/baileys/lib/Socket/socket.js"
  );
  if (!fs.existsSync(socketFile)) continue;

  const source = fs.readFileSync(socketFile, "utf8");
  const start = source.indexOf("const requestPairingCode = async");
  if (start < 0) throw new Error("Baileys requestPairingCode implementation was not found");

  const endCandidates = [
    source.indexOf("async function generatePairingKey", start),
    source.indexOf("const sendWAMBuffer", start)
  ].filter((index) => index > start);
  const end = endCandidates.length ? Math.min(...endCandidates) : -1;
  if (end < 0) throw new Error("Could not isolate Baileys pairing-code method");

  const method = source.slice(start, end);
  const queryIndex = method.indexOf("await query({");
  const meIndex = method.indexOf("authState.creds.me =");
  const emitIndex = method.indexOf("ev.emit('creds.update', authState.creds);");
  if (queryIndex >= 0 && meIndex > queryIndex && emitIndex > queryIndex) {
    console.log("Baileys pairing acknowledgement patch is already present");
    continue;
  }
  if (queryIndex < 0 && !method.includes("await sendNode({")) {
    throw new Error("Expected fire-and-forget pairing IQ was not found; refusing unsafe patch");
  }

  let patchedMethod = method.replace("await sendNode({", "await query({");
  const earlyMeAssignment = /authState\.creds\.me\s*=\s*\{\s*id:\s*jidEncode\(phoneNumber,\s*['"]s\.whatsapp\.net['"]\),\s*name:\s*['"]~['"]\s*\};?\s*/;
  if (!earlyMeAssignment.test(patchedMethod)) {
    throw new Error("Could not safely locate the pre-acknowledgement device identity assignment");
  }
  patchedMethod = patchedMethod.replace(earlyMeAssignment, "");
  patchedMethod = patchedMethod.replace("ev.emit('creds.update', authState.creds);", "");
  const returnMarker = "return authState.creds.pairingCode;";
  if (!patchedMethod.includes(returnMarker)) {
    throw new Error("Could not locate pairing-code return point");
  }
  patchedMethod = patchedMethod.replace(
    returnMarker,
    "authState.creds.me = { id: jidEncode(phoneNumber, 's.whatsapp.net'), name: '~' };\n\t\tev.emit('creds.update', authState.creds);\n\t\treturn pairingCode;"
  );
  const patchedSource = source.slice(0, start) + patchedMethod + source.slice(end);
  fs.writeFileSync(socketFile, patchedSource, "utf8");
  patchedCount += 1;
}

if (patchedCount === 0 && packageDirs.length > 0) {
  // An already-patched package is valid; otherwise fail rather than silently
  // shipping the old fire-and-forget pairing implementation.
  const candidates = packageDirs.map((name) =>
    path.join(pnpmStore, name, "node_modules/@whiskeysockets/baileys/lib/Socket/socket.js")
  );
  const verified = candidates.some((file) => {
    if (!fs.existsSync(file)) return false;
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf("const requestPairingCode = async");
    const end = source.indexOf("async function generatePairingKey", start);
    return start >= 0 && end > start && source.slice(start, end).includes("await query({");
  });
  if (!verified) throw new Error("Baileys pairing acknowledgement patch was not applied");
}

console.log(`Baileys pairing acknowledgement patch applied to ${patchedCount} package instance(s)`);
