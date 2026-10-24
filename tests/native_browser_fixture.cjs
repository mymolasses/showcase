/* Shared macOS native bridge build; same pinned libraries as the iOS package. */
const path=require('node:path');
const {execFileSync}=require('node:child_process');
module.exports=function compileBridge(output,harness='browser_bridge_harness.m') {
  const root=path.resolve(__dirname,'..');
  const result=execFileSync('python3',[path.join(root,'tools/browser_native.py'),'--flags','macos'],{encoding:'utf8'});
  const flags=JSON.parse(result.trim().split('\n').pop());
  execFileSync('clang',['-fobjc-arc','-Wno-deprecated-declarations','-framework','Foundation','-framework','Security',
    ...(process.env.SHOWCASE_TEST_VT_UNAVAILABLE==='1' ? ['-include',path.join(root,'tests/force_vt_unavailable.h')] : []),
    ...['browser_bridge.m','browser_jpeg.m','browser_rtc.m'].map(name=>path.join(root,'source',name)),
    path.join(root,'tests',harness),...flags,'-o',output],{stdio:'inherit'});
  return flags;
};
