/* SPDX-License-Identifier: GPL-3.0-or-later. Native updater against real test-CA P12 identities. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const fixture=require('./browser_web_fixture.cjs'),root=path.resolve(__dirname,'..');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'showcase-managed-native-'));
try{
 const domain='car.littlepond.eu.org',cert=fixture(work,domain);
 const first=fs.readFileSync(path.join(work,'browser-server.p12')).toString('base64');
 const run=args=>execFileSync('/usr/bin/openssl',args,{cwd:work,stdio:'pipe'});
 run(['req','-newkey','rsa:2048','-nodes','-subj','/CN='+domain,'-keyout','rotated.key','-out','rotated.csr']);
 run(['x509','-req','-in','rotated.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-days','2','-extfile','cert.ext','-out','rotated.pem']);
 run(['pkcs12','-export','-inkey','rotated.key','-in','rotated.pem','-certfile','ca.pem','-out','rotated.p12','-passout','pass:qa-fixture-only']);
 const common={domain,identityPassword:cert.password,notAfter:new Date(Date.now()+86400000).toISOString(),clientToken:'b'.repeat(64),clientId:'d'.repeat(64)};
 fs.writeFileSync(path.join(work,'first.json'),JSON.stringify({...common,pkcs12Base64:first,fingerprint:'1'.repeat(64)}));
 fs.writeFileSync(path.join(work,'second.json'),JSON.stringify({...common,pkcs12Base64:fs.readFileSync(path.join(work,'rotated.p12')).toString('base64'),fingerprint:'2'.repeat(64)}));
 const activationCode='a'.repeat(64);
 fs.writeFileSync(path.join(work,'activation.json'),JSON.stringify({domain,serviceURL:'https://setup.littlepond.eu.org',activationCode,
  activationId:crypto.createHash('sha256').update(activationCode).digest('hex')}));
 execFileSync('clang',['-fobjc-arc','-DSC_MANAGED_TEST=1','-DSC_PROBE_TEST=1','-Wno-deprecated-declarations','-framework','Foundation','-framework','Security',
  path.join(root,'tests/managed_access_harness.m'),path.join(root,'source/browser_managed_access.m'),path.join(root,'source/browser_web_tls.m'),'-o',path.join(work,'managed-test')],{stdio:'inherit'});
 execFileSync(path.join(work,'managed-test'),[work],{stdio:'inherit',timeout:60000,env:{...process.env,SC_MANAGED_TEST_DIRECTORY:work,SC_MANAGED_TEST_ANCHOR:cert.root}});
}finally{fs.rmSync(work,{recursive:true,force:true});}
