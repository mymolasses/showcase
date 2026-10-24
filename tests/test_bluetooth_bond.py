"""Replay missing-key HCI events through the production recovery handler."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'source/carplay_bt.m').read_text(encoding='utf-8')
start = source.index('static uint16_t bond_recovery_handle')
function = source[start:source.index('static void load_last_iphone(void) {', start)]
assert 'recover_missing_bluetooth_key(pkt, sz);' in source
harness = r'''
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#define R16(b,p) (((uint16_t)(b)[(p)+1])<<8|(b)[(p)])
static int page_known = 1, calls;
static uint8_t page_addr[6] = {0x10,0x20,0x30,0x40,0x50,0x60};
static const void *hci_delete_stored_link_key;
static void bt_send_cmd(const void *cmd, ...) {
    assert(cmd == &hci_delete_stored_link_key);
    va_list args; va_start(args, cmd);
    const uint8_t *addr = va_arg(args, const uint8_t *);
    assert(!memcmp(addr, page_addr, 6));
    assert(va_arg(args, int) == 0); /* never delete other devices' keys */
    va_end(args); ++calls;
}
''' + function + r'''
static void feed(uint8_t *p, uint16_t n) { recover_missing_bluetooth_key(p, n); }
static void reset(void) { calls=0; bond_recovery_handle=UINT16_MAX; bond_recovery_attempted=0; bond_recovery_pending=0; page_known=1; }
int main(void) {
    uint8_t conn[]={3,11,0,0x0b,0,0x60,0x50,0x40,0x30,0x20,0x10,1,0};
    uint8_t auth[]={6,3,6,0x0b,0};
    uint8_t disc[]={5,4,0,0x0b,0,0x16};
    reset(); feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending);
    for (uint16_t n=0;n<sizeof conn;++n) feed(conn,n);
    assert(bond_recovery_handle==UINT16_MAX);
    feed(conn,sizeof conn);
    for (uint16_t n=0;n<sizeof auth;++n) feed(auth,n);
    assert(!calls && !bond_recovery_pending);
    feed(auth,sizeof auth); assert(!calls && bond_recovery_pending);
    feed(auth,sizeof auth); feed(disc,sizeof disc); assert(calls==1);
    conn[3]=auth[3]=0x0c; feed(conn,sizeof conn); feed(auth,sizeof auth);
    disc[3]=0x0c; feed(disc,sizeof disc);
    assert(calls==1); /* retries do not keep deleting a freshly created bond */
    reset(); page_known=0; feed(conn,sizeof conn); feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending);
    reset(); conn[5]^=1; feed(conn,sizeof conn); feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); conn[5]^=1;
    reset(); conn[2]=4; feed(conn,sizeof conn); feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); conn[2]=0;
    reset(); feed(conn,sizeof conn); auth[3]^=1; feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); auth[3]^=1;
    auth[2]=0; feed(auth,sizeof auth); auth[2]=5; feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); auth[2]=6;
    disc[3]=conn[3]; feed(disc,sizeof disc); feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending);
    reset(); feed(conn,sizeof conn); page_addr[0]^=1; feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); page_addr[0]^=1;
    reset(); feed(conn,sizeof conn); auth[1]=255; feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); auth[1]=3;
    auth[1]=0; feed(auth,sizeof auth); assert(!calls && !bond_recovery_pending); auth[1]=3;
    /* A failure on a different handle or peer must never arm deletion. */
    reset(); feed(conn,sizeof conn); auth[3]^=1; feed(auth,sizeof auth);
    feed(disc,sizeof disc); assert(!calls); auth[3]^=1;
    reset(); feed(conn,sizeof conn); feed(auth,sizeof auth); page_addr[0]^=1;
    feed(disc,sizeof disc); assert(!calls); page_addr[0]^=1;
    reset(); feed(conn,sizeof conn); feed(auth,sizeof auth); disc[3]^=1;
    feed(disc,sizeof disc); assert(!calls); disc[3]^=1;
    puts("PASS: missing-key recovery targets only the known peer/handle once; rejects malformed and unrelated events");
}
'''
with tempfile.TemporaryDirectory(prefix='showcase-bond-') as directory:
    work = Path(directory)
    (work / 'check.c').write_text(harness, encoding='utf-8')
    compiler = os.environ.get('CC') or shutil.which('clang') or shutil.which('gcc')
    assert compiler, 'A C compiler is required'
    syntax_only = bool(os.environ.get('SHOWCASE_TEST_SYNTAX_ONLY'))
    target = work / ('check.s' if syntax_only else 'check.exe' if os.name == 'nt' else 'check')
    subprocess.run([compiler, '-std=c11', '-Wall', '-Wextra', '-Werror',
                    *(['-S'] if syntax_only else []), str(work/'check.c'), '-o', str(target)], check=True)
    if syntax_only:
        print('Syntax check only; runtime cases have NOT been executed')
    else:
        subprocess.run([str(target)], check=True, timeout=10)
