# Configuration and short-prompt replay

These examples document the tested topology. They do not install model weights, configure Windows networking, or claim to be a complete deployment installer. Use the pinned [StrataLink source](https://github.com/lask3802/Strata/tree/3015d458b52e7787bc10b2c38717973b321914a9) and its [remote-stage instructions](https://github.com/lask3802/Strata/blob/3015d458b52e7787bc10b2c38717973b321914a9/docs/REMOTE_STAGE.md). The main process needs a CUDA build and the APEX worker a HIP `gfx1151` build of that same source.

The public examples use `192.0.2.11` (a documentation address) for the worker and generic `C:\Strata` paths. Replace both with your local settings. Generate your own stage secret and store it in a protected local file; use the same value on both PCs through `STRATA_STAGE_TOKEN`. Secrets, node configuration and weights should remain outside this repository.

Both machines need a compatible native pack, its GGUF sources and the expert profile. Their pack fingerprints and KV settings must agree. The actual main process used both full model shards, while the worker received its own layers' data with the fork's shipping tooling. Do not substitute a pack with externally combined experts for a native range-capable pack.

## Worker arguments

The tested worker's node agent constructed the following equivalent engine arguments. Start the worker before the main process. The example repeats `--prefill` only once; the node agent's configuration and start request both specified the same 2,048-token chunk.

```powershell
$env:STRATA_STAGE_TOKEN = [IO.File]::ReadAllText('C:\Strata\private\stage-token').Trim()
& 'C:\Strata\bin-hip\strata.exe' --serve `
  --stage-worker 7841 --stage-begin 44 --stage-bind 192.0.2.11 `
  --pack 'C:\Strata\packs\iq3_xxs' `
  --native 'C:\Strata\models\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf' `
  --ple-gguf 'C:\Strata\models\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00002-of-00002.gguf' `
  --expert-profile 'C:\Strata\data\expert-profile.bin' `
  --expert-cache 2048 --prefill 2048 --spec 4 `
  --max-context 131072 --kv-resident 32768 --kv int8 `
  --vision --pool-workers 4
```

The `--vision` flag here supports image positions in the model-stage protocol; the image encoder runs on the primary CPU. No `--mtp` is passed to the worker. The example's `--expert-cache 2048` means slots, not MiB. The equivalent tested agent used TCP port 7840 with a token-protected API; direct engine launch alone does not create that agent or its `/info` endpoint for the monitor.

## Main configuration excerpt

These are the actual main engine arguments with local paths and the worker address replaced. Insert them in the pinned fork's regular server configuration; this excerpt alone is not a complete API-server configuration. The API server was bound to loopback port 8081 and used model alias `iq3_xxs`.

```json
{
  "args": [
    "--pack", "C:\\Strata\\packs\\iq3_xxs",
    "--native", "C:\\Strata\\models\\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf",
    "--ple-gguf", "C:\\Strata\\models\\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00002-of-00002.gguf",
    "--expert-profile", "C:\\Strata\\data\\expert-profile.bin",
    "--expert-cache", "auto",
    "--spec", "4", "--spec-min-p", "0.5",
    "--mtp", "C:\\Strata\\mtp\\rt",
    "--max-context", "131072", "--kv", "int8",
    "--vision", "--pool-workers", "10", "--prefill", "2048",
    "--conversation-cache-mib", "256", "--vram-reserve-mib", "1212",
    "--kv-resident", "32768", "--prompt-cache", "2",
    "--layer-split", "44", "--split-device", "0",
    "--remote-stage", "192.0.2.11:7841", "--pipeline-windows", "0"
  ],
  "vision": {
    "exe": "C:\\Strata\\bin-cuda\\strata-vision.exe",
    "mmproj": "C:\\Strata\\models\\mmproj-Qwen3.8-Flash-Next-BF16.gguf",
    "model": "C:\\Strata\\models\\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf",
    "gpu": false,
    "max_tokens": 300,
    "threads": 8
  }
}
```

`--spec 4` is the CLI draft limit. An engine metrics snapshot reports `spec=6` as an internal capability bitmask together with `mtp_max=4`; it does not mean six drafts were requested. The runtime's auto expert-cache result during the later short checks was 2,300 slots / 3,802 MiB. No explicit `--pcie-frac` was present in the saved main configuration.

`--conversation-cache-mib 256` was inherited from the base profile. Remote session/prompt checkpoint behavior is controlled by the fork and `--prompt-cache 2`; a retained flag is not proof that a separate 256 MiB conversation-parking allocation was active. Inspect startup logs for effective settings.

For the historical 32K cluster cohort, `--max-context` was `32768`, and the added `--kv-resident 32768` and `--prompt-cache 2` arguments were absent. The historical single-PC baseline used engine **0.1.47**, the same base model/MTP/prefill/vision settings, `--max-context 32768`, and none of the remote-stage/layer-split arguments. This engine-version difference prevents an isolated split-only comparison. A stronger future test would use the same pinned fork for both baseline and cluster, multiple repetitions and controlled foreground load.

The reserve value shown records the actual setup; it is not a recommendation that every 12 GB GPU has enough headroom. The measured system emitted low-free-VRAM warnings and needs further long-session validation.

## Replay the neutral 256-token prompts

The historical request loop used the following exact prompts. The example below can be run from a separate Python file against an already running OpenAI-compatible server. It uses only the standard library, writes only numeric timing data, and performs one warmup followed by three requests. Set `STRATA_BASE_URL`, `STRATA_API_KEY` and `STRATA_MODEL` in your local environment; the API key is never printed. Configure the intended 32K or 128K engine profile before running; the script does not change server context or start a model.

```python
import json
import os
import time
import urllib.request

base = os.environ.get('STRATA_BASE_URL', 'http://127.0.0.1:8081/v1').rstrip('/')
key = os.environ['STRATA_API_KEY']
model = os.environ.get('STRATA_MODEL', 'iq3_xxs')
prompts = [
    ('warmup', 'Reply with the word ready.', 16),
    ('code', 'Write a complete Python function that reads a CSV of date, category, amount, validates each row and returns monthly totals using Decimal. Include error handling and an example.', 256),
    ('explanation', 'Explain how a CPU, GPU, RAM and SSD cooperate during local large language model inference. Use clear examples and describe the main bottlenecks in about 500 words.', 256),
    ('prose', 'Write a detailed story about an engineer repairing a mountain radio station during a snowstorm. Include practical details and dialogue. Continue for at least 500 words.', 256),
]
rows = []
for name, prompt, limit in prompts:
    payload = dict(model=model, messages=[dict(role='user', content=prompt)],
                   max_tokens=limit, temperature=0, stream=False,
                   chat_template_kwargs={'enable_thinking': False})
    req = urllib.request.Request(base + '/chat/completions',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + key})
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=240) as response:
        data = json.load(response)
    row = dict(name=name, wall_seconds=round(time.monotonic()-started, 3),
               completion_tokens=data.get('usage', {}).get('completion_tokens'),
               timings=data.get('timings'),
               finish_reason=data['choices'][0].get('finish_reason'))
    rows.append(row)
    print(json.dumps(row))
with open('short-prompt-results.json', 'w', encoding='utf-8') as output:
    json.dump({'rows': rows, 'runs_per_prompt': 1}, output, indent=2)
```

The original baseline request loop used `--bench-only` and the cluster loop additionally performed arithmetic, forced-tool and vision checks before the three prompts. Thus there were different earlier cache histories. Neither report records a reset of expert-cache state between each prompt. The quoted times are server-reported decode throughput and end-to-end client wall time, which measure different parts of a request.

For the 128K short-decode cohort, exact prompt strings were not preserved in the numeric evidence. For the two-turn prompt-cache test, the saved evidence includes a neutral-fixture SHA-256 and counts, but not its complete text. These cohorts support the stated local smoke-test observations and are not exactly replayable from this repository. A future complete benchmark should preserve public neutral fixtures and use the project's [community benchmark protocol](https://github.com/Niko1221/Strata/blob/main/docs/COMMUNITY_BENCHMARKS.md).
