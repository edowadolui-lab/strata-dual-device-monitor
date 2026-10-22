# Install the Windows monitor

Copyright (c) 2026 edowadolui-lab. The original monitor and installer are distributed under the [MIT license](../LICENSE).

## Before installing

Use Windows 10 or 11 on an x64 PC. The package includes a pinned official Node.js runtime, so no separate Node installation is needed. It installs for the current Windows user without administrator access.

The monitor reads an existing StrataLink installation. You need the primary engine's loopback metrics URL and API key, a compatible remote telemetry agent's private-network `/info` URL and token, and the exact remote stage address reported by the engine. StrataLink, model weights, GPU drivers, DeepSeek Harness and the remote telemetry agent are separate components. The [README](../README.md#telemetry-contract-and-limits) documents the required agent contract.

## Install and configure

1. Download `strata-dual-device-monitor-v0.1.0-windows-x64.zip` from [GitHub Releases](https://github.com/edowadolui-lab/strata-dual-device-monitor/releases). `SHA256SUMS.txt` contains its checksum.
2. Extract the complete ZIP, open its folder, and run `Install.cmd`.
3. Open **Start > Strata Dual Device Monitor > Configure Monitor**. Enter your existing endpoints, stage address and credentials. Enter the hardware labels that match your remote PC.
4. Open **Strata Dual Device Monitor** from the desktop or Start menu. Its browser dashboard runs at `http://127.0.0.1:47832`.

The first release is an unsigned Windows preview. The package contains the app, installer scripts, official Node runtime and license notices. Configuration is saved in your own Windows profile, outside the application folder. API credentials are entered through masked prompts and the configuration folder is restricted to your Windows account and SYSTEM.

Application files: `%LOCALAPPDATA%\Programs\StrataDualDeviceMonitor`.

Configuration and monitor logs: `%LOCALAPPDATA%\StrataDualDeviceMonitor`.

The configuration file contains credentials. Keep it local and do not include it in bug reports. The monitor binds to loopback and has no model-control endpoints. Closing the browser leaves the local monitor running; use **Stop Monitor** to stop its background process.

Optional MTP and image-projector file checks are configured in this local `config.json`, using the fields documented in the [README](../README.md#run-from-source). Enable them only when the existing engine uses those features; the installer does not download or activate model support files.

If another copy already occupies port 47832, stop that copy with its own launcher. This installer does not take over other monitor or model processes.

## Update or remove

To update, use **Stop Monitor**, extract the newer ZIP and run its `Install.cmd`. Existing configuration is preserved. Use Configure Monitor again if your engine endpoint, token or stage address changes.

Use **Uninstall Monitor** in the same Start-menu folder to remove this monitor and its shortcuts. Saved configuration is preserved by default. The installed `scripts\uninstall.ps1` supports `-RemoveUserData` when you deliberately want to remove that local configuration too. No uninstall option removes Strata, model weights, drivers or the remote agent.

## What to expect

The layer diagram comes from engine metrics and shows each device's role. Generation speed describes the whole model. AMD GPU sensor readings remain unavailable with the current telemetry contract; remote host memory and worker-process status can still appear. Configured context capacity is not proof of testing at that complete prompt length. Live screenshots and measured tests are documented separately in the [hardware report](hardware-report.md).

The release build runs monitor tests and an isolated install/start/health/stop/upgrade/uninstall smoke test. These checks validate packaging and monitoring behavior; they do not run a model or establish inference correctness on other hardware.
