# Browser implementation and dependencies

The single browser renderer is an original GPL-3.0-or-later implementation using standard WebCodecs,
Worker, OffscreenCanvas, WebGL2 and WebSocket APIs. Inspection of the supplied TarPlay browser page
informed the architecture; its scripts were not copied or redistributed in this repository.

The Broadway/WASM decoder, JPEG/FFmpeg fallback and libdatachannel WebRTC backend have been removed,
including their bundled browser assets, native build dependencies and generated release artifacts.
Existing unrelated CarPlay cryptography and BTstack licensing remain unchanged.
