/* The browser bridge forwards AVC and needs no media libraries. */
const path=require('node:path');
const {execFileSync}=require('node:child_process');
module.exports=function compileBridge(output,harness='browser_bridge_harness.m') {
  const root=path.resolve(__dirname,'..');
  execFileSync('clang',['-fobjc-arc','-Wno-deprecated-declarations','-framework','Foundation','-framework','Security',
    path.join(root,'source/browser_bridge.m'),path.join(root,'tests',harness),'-o',output],{stdio:'inherit'});
};
