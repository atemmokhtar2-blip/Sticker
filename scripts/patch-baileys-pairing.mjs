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

const replacement = `const requestPairingCode = async (phoneNumber, customPairingCode) => {
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5));

    if (customPairingCode && customPairingCode.length !== 8) {
      throw new Error('Custom pairing code must be exactly 8 chars');
    }

    authState.creds.pairingCode = pairingCode;
    const jid = jidEncode(phoneNumber, 's.whatsapp.net');

    try {
      const result = await query({
        tag: 'iq',
        attrs: {
          to: S_WHATSAPP_NET,
          type: 'set',
          xmlns: 'md'
        },
        content: [
          {
            tag: 'link_code_companion_reg',
            attrs: {
              jid,
              stage: 'companion_hello',
              should_show_push_notification: 'true'
            },
            content: [
              {
                tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                attrs: {},
                content: await generatePairingKey()
              },
              {
                tag: 'companion_server_auth_key_pub',
                attrs: {},
                content: authState.creds.noiseKey.public
              },
              {
                tag: 'companion_platform_id',
                attrs: {},
                content: getCompanionPlatformId(browser)
              },
              {
                tag: 'companion_platform_display',
                attrs: {},
                content: browser[1] + ' (' + browser[0] + ')'
              },
              {
                tag: 'link_code_pairing_nonce',
                attrs: {},
                content: '0'
              }
            ]
          }
        ]
      });

      if (!result) {
        throw new Boom('Timed out waiting for pairing code response', {
          statusCode: DisconnectReason.timedOut
        });
      }
    } catch (error) {
      if (authState.creds.pairingCode === pairingCode) {
        authState.creds.pairingCode = undefined;
      }
      throw error;
    }

    authState.creds.me = { id: jid, name: '~' };
    ev.emit('creds.update', authState.creds);
    return pairingCode;
  };

`;

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

  const end = source.indexOf("async function generatePairingKey", start);
  if (end < 0) throw new Error("Could not isolate Baileys pairing-code method");

  const method = source.slice(start, end);
  if (
    method.includes("const jid = jidEncode(phoneNumber, 's.whatsapp.net')") &&
    method.includes("await query({") &&
    method.includes("authState.creds.me = { id: jid, name: '~' }")
  ) {
    console.log("Baileys pairing acknowledgement patch is already present");
    continue;
  }

  if (!method.includes("await sendNode({") && !method.includes("await query({")) {
    throw new Error("Unexpected Baileys pairing implementation; refusing unsafe patch");
  }

  const patchedSource = source.slice(0, start) + replacement + source.slice(end);
  fs.writeFileSync(socketFile, patchedSource, "utf8");
  patchedCount += 1;
}

if (patchedCount === 0) {
  const verified = packageDirs.some((packageDir) => {
    const file = path.join(
      pnpmStore,
      packageDir,
      "node_modules/@whiskeysockets/baileys/lib/Socket/socket.js"
    );
    if (!fs.existsSync(file)) return false;
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf("const requestPairingCode = async");
    const end = source.indexOf("async function generatePairingKey", start);
    if (start < 0 || end < 0) return false;
    const method = source.slice(start, end);
    return method.includes("const jid = jidEncode(phoneNumber, 's.whatsapp.net')") &&
      method.includes("await query({") &&
      method.includes("authState.creds.me = { id: jid, name: '~' }");
  });
  if (!verified) throw new Error("Baileys pairing acknowledgement patch was not applied");
}

console.log(`Baileys pairing acknowledgement patch applied to ${patchedCount} package instance(s)`);
