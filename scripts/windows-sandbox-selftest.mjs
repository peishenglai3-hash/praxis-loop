import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.stdout.write('windows-appcontainer-selftest-started\n');

async function connect(host, port, timeoutMs = 1500) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

assert.equal(process.env.PRAXIS_LOOP_APPCONTAINER_VERIFIED, '1', 'launcher must verify the AppContainer token before resume');
assert.equal(process.env.PRAXIS_LOOP_JOB_OBJECT_VERIFIED, '1', 'launcher must verify Job Object assignment before resume');
assert.equal(process.env.PRAXIS_LOOP_NO_NETWORK_CAPABILITIES, '1', 'launcher must provide no network capabilities');
assert.ok(process.env.PRAXIS_LOOP_APPCONTAINER_SID, 'AppContainer SID must be present');

const writePath = join(tmpdir(), `praxis-appcontainer-write-${process.pid}.txt`);
writeFileSync(writePath, 'sandbox-write-ok', { flag: 'wx' });
assert.equal(readFileSync(writePath, 'utf8'), 'sandbox-write-ok');
unlinkSync(writePath);

let sentinelDenied = false;
try { readFileSync(process.env.PRAXIS_LOOP_SENTINEL, 'utf8'); }
catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) sentinelDenied = true; else throw error; }
assert.equal(sentinelDenied, true, 'AppContainer must not read the host-only sentinel');

const loopbackConnected = await connect('127.0.0.1', Number(process.env.PRAXIS_LOOP_LOOPBACK_PORT));
assert.equal(loopbackConnected, false, 'AppContainer must not connect to the host loopback listener');

let externalNetwork = 'not-tested-host-egress-unavailable';
if (process.env.PRAXIS_LOOP_EXTERNAL_PROBE === '1') {
  const externalConnected = await connect('1.1.1.1', 443, 2000);
  assert.equal(externalConnected, false, 'AppContainer without network capabilities must not reach the external network');
  externalNetwork = 'blocked-host-egress-available';
}

const credentialNames = ['GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY'];
const leakedCredentials = credentialNames.filter((name) => process.env[name]);
assert.deepEqual(leakedCredentials, [], 'the launcher must provide a minimal, credential-free environment');

const report = {
  schemaVersion: 1,
  status: 'passed',
  isolation: 'Windows AppContainer; no network capabilities; Job Object kill-on-close',
  appContainerSid: process.env.PRAXIS_LOOP_APPCONTAINER_SID,
  jobMembership: true,
  writableSandboxPath: writePath,
  hostOnlySentinel: 'denied',
  loopbackNetwork: 'blocked',
  externalNetwork,
  capabilities: [],
  credentialEnvironmentClear: true,
};
writeFileSync(join(process.env.PRAXIS_LOOP_EVIDENCE_DIR, 'windows-preflight.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(report)}\n`);
