"""GET/info probes must not count as an iPhone beginning pairing."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1]/'source/carplay_services.m').read_text(encoding='utf-8')
start = source.index('static void route_request(')
router = source[start:source.index('static void handle_client(', start)]
listener = source[source.index('static bool start_airplay_server('):source.index('static bool start_airplay_server(')+2300]
assert 'app_send_status(STATUS_IPHONE_CONNECTED)' not in listener
harness = r'''
#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <assert.h>
typedef struct {
 const char *method, *path, *protocol;
 const uint8_t *body; size_t bodyLen;
} HTTPReq;
#define STATUS_IPHONE_CONNECTED 1
static int statuses;
static void app_send_status(uint8_t code) { assert(code==1); ++statuses; }
'''
for name in sorted(set(re.findall(r'\b(handle_\w+|send_ok)\(', router))):
    harness += f'static void {name}(int s,const HTTPReq*r){{(void)s;(void)r;}}\n'
harness += router + r'''
static void check(const char *method,const char *path,bool body,int expected) {
 static const uint8_t payload[]={1};
 HTTPReq r={method,path,"HTTP/1.1",body ? payload : NULL,body ? 1 : 0};
 statuses=0; route_request(0,&r); assert(statuses==expected);
}
int main(void) {
 check("GET","/info",false,0); check("GET","/pair-setup",true,0);
 check("OPTIONS","*",false,0); check("POST","/feedback",true,0);
 check("POST","/pair-setup",false,0); check("POST","/pair-verify",false,0);
 check("POST","/auth-setup",false,0); check("POST","/not-pair-verify",true,0);
 check("POST","/pair-setup",true,1); check("POST","/pair-verify",true,1);
 check("POST","/auth-setup",true,1);
 puts("PASS: probes do not advance pairing; nonempty pairing/auth requests do");
}
'''
with tempfile.TemporaryDirectory(prefix='showcase-progress-') as directory:
    work=Path(directory)
    (work/'check.c').write_text(harness,encoding='utf-8')
    compiler=os.environ.get('CC') or shutil.which('clang') or shutil.which('gcc')
    assert compiler, 'A C compiler is required'
    syntax_only=bool(os.environ.get('SHOWCASE_TEST_SYNTAX_ONLY'))
    target=work/('check.s' if syntax_only else 'check.exe' if os.name=='nt' else 'check')
    subprocess.run([compiler,'-std=c11','-Wall','-Wextra','-Werror',
                    *(['-S'] if syntax_only else []),str(work/'check.c'),'-o',str(target)],check=True)
    if syntax_only:
        print('Syntax check only; runtime cases have NOT been executed')
    else:
        result=subprocess.run([str(target)],text=True,capture_output=True,check=True,timeout=10)
        print(result.stdout.splitlines()[-1])
