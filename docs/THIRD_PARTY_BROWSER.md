# Browser backend sources and notices

The new JPEG, protocol, control and rendering wrappers are Showcase fork code under GPL-3.0-or-later. Architectural references are not a claim of vehicle compatibility or affiliation.

- Tesla Android frontend: https://github.com/tesla-android/frontend at `34763a62819a1dedad9d3eb62f1e175f2659091f`. The vendored Broadway Decoder.js, YUVCanvas.js and avc.wasm are unmodified inputs, with exact source URLs and SHA-256 in `web/vendor/broadway/provenance.json`. Its GPL-3.0 license is retained alongside the upstream Broadway license and README. Broadway originates from the Android H.264 decoder compiled with Emscripten: https://github.com/mbebenita/Broadway.
- libdatachannel `v0.24.1`, commit `a02b751917ac8afc8c58dc6f4461d25ff9465d48`, MPL-2.0: https://github.com/paullouisageneau/libdatachannel. Its recursively checked-out dependency revisions are pinned by that commit's gitlinks. This includes libjuice, libSRTP, usrsctp, plog and nlohmann/json; their original license files are copied into the package.
- Mbed TLS `mbedtls-3.6.5`, commit `e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df`, Apache-2.0 or GPL-2.0-or-later as stated in its source licensing: https://github.com/Mbed-TLS/mbedtls. Original license and notice files are distributed.
- OpenCarStream: https://github.com/JoyLau/opencarstream and https://github.com/santibacat/opencarstream, referenced for the multipart JPEG architecture. No Python, FFmpeg commands, downloader or entertainment site implementation is copied into Showcase.
- WheelPlay: https://github.com/fython/wheelplay, referenced for selectable backends, JPEG fallback and offscreen-video Canvas limitations; its Android app and JNI implementation are not copied.
- PlayPort: https://github.com/youcci/playport, referenced for direct WebCodecs CarPlay display. Its Kotlin receiver and TypeScript source are not copied.

Browser vendor notices and native dependency license files are installed under `/var/jb/usr/share/showcase/licenses/`. Reproducible source and the Release tag are available at https://github.com/mymolasses/showcase; build provenance records the source commit and dependency pins. Existing Showcase and CarPlay runtime notices remain applicable.
