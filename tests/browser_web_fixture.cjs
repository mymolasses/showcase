/* SPDX-License-Identifier: GPL-3.0-or-later. Local, short-lived test CA only. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
module.exports = function certificate(work, domain) {
  const run = args => execFileSync('/usr/bin/openssl', args, {cwd: work, stdio: ['ignore', 'pipe', 'pipe']});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Showcase temporary test CA','-keyout','ca.key','-out','ca.pem']);
  run(['req','-newkey','rsa:2048','-nodes','-subj','/CN='+domain,'-keyout','server.key','-out','server.csr']);
  fs.writeFileSync(path.join(work,'cert.ext'),'subjectAltName=DNS:'+domain+'\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  run(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-days','2','-extfile','cert.ext','-out','server.pem']);
  run(['pkcs12','-export','-inkey','server.key','-in','server.pem','-certfile','ca.pem','-out','browser-server.p12','-passout','pass:qa-fixture-only']);
  run(['x509','-in','ca.pem','-outform','DER','-out','ca.der']);
  const publicKey=run(['x509','-in','server.pem','-pubkey','-noout']);
  const der=execFileSync('/usr/bin/openssl',['pkey','-pubin','-outform','DER'],{input:publicKey});
  return {domain, password:'qa-fixture-only', root:path.join(work,'ca.der'), ca:fs.readFileSync(path.join(work,'ca.pem')),
    spki:crypto.createHash('sha256').update(der).digest('base64')};
};
