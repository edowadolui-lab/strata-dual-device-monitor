# Third-party runtime

The original Strata Dual Device Monitor program and installer are copyright (c) 2026 edowadolui-lab and distributed under the repository's MIT license.

The Windows installation package also contains the official Node.js runtime. Node.js is a separate project maintained by its contributors. Its complete license and third-party notices are included as `runtime/LICENSE` in the installation ZIP, alongside its upstream README and pinned download/checksum metadata in `runtime/runtime.json`.

Runtime source and distribution: <https://nodejs.org/> and <https://github.com/nodejs/node>. The exact version and official archive SHA-256 are pinned in [packaging/runtime.json](packaging/runtime.json).

Strata and StrataLink are separate inference-engine projects referenced for compatibility. Their engine code and binaries, GPU drivers, model weights, DeepSeek Harness and the remote telemetry agent are not distributed in this package. The copyright notice for this monitor does not claim ownership of those projects.
