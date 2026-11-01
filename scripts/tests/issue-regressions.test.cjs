const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("text-to-image sends seed and sampling settings to sdapi", async () => {
  const api = read("app/frontend/src/services/api.js");
  assert.match(api, /\/sdapi\/v1\/txt2img/);
  assert.doesNotMatch(api, /\/v1\/images\/generations/);

  const calls = [];
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  global.window = { location: { protocol: "http:" } };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        images: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII="],
      }),
    };
  };

  try {
    const moduleUrl = `${pathToFileURL(path.join(root, "app/frontend/src/services/api.js")).href}?regression-test`;
    const { generateImage } = await import(moduleUrl);
    const result = await generateImage("a rocket", "", {
      width: 640,
      height: 384,
      steps: 17,
      cfgScale: 6.5,
      seed: 123456,
      sampler: "euler_a",
    }, "model.safetensors", null);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/sdapi/v1/txt2img");
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual({
      width: body.width,
      height: body.height,
      steps: body.steps,
      cfg_scale: body.cfg_scale,
      seed: body.seed,
      sampler_name: body.sampler_name,
    }, {
      width: 640,
      height: 384,
      steps: 17,
      cfg_scale: 6.5,
      seed: 123456,
      sampler_name: "euler_a",
    });
    assert.equal(result.seed, 123456);
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
  }
});

test("slow image generation has no fixed proxy timeout and blocks destructive restarts", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function proxyImageBackendRequest[\s\S]*?timeout:\s*0/);
  assert.match(server, /if \(generationState\.active\)[\s\S]*?Image generation is in progress/);
});

test("Windows OpenVINO setup only accepts Intel NPUs and remains optional", () => {
  const setup = read("scripts/setup/setup.ps1");
  const openvino = read("scripts/setup/setup-openvino-npu.ps1");
  assert.match(setup, /function Get-IntelOpenVinoNpu/);
  assert.match(setup, /Intel.*AI Boost\|NPU/);
  assert.match(setup, /Continuing with the available GPU\/CPU backends/);
  assert.match(openvino, /Intel.*AI Boost\|NPU/);
  assert.doesNotMatch(setup, /\$_.Name -match "NPU"/);
  assert.doesNotMatch(openvino, /\$_.Name -match "NPU"/);
});

test("macOS launch and setup detect Apple Silicon even under Rosetta", () => {
  for (const relativePath of [
    "mac.sh",
    "scripts/setup/setup.sh",
    "scripts/setup/setup-llama.sh",
    "scripts/setup/setup-whisper.sh",
    "scripts/setup/setup-coreml-npu.sh",
  ]) {
    assert.match(read(relativePath), /hw\.optional\.arm64/, relativePath);
  }
  assert.match(read("scripts/setup/setup.sh"), /INSTALLED_NODE_ARCH/);
});

test("Linux setup detects required libraries and rejects mixed ROCm Vulkan files", () => {
  const setup = read("scripts/setup/setup.sh");
  assert.match(setup, /libgomp\.so\.1/);
  assert.match(setup, /libvulkan\.so\.1/);
  assert.match(setup, /hipblas\|rocblas\|amdhip/);
  assert.match(setup, /rm -f "\$VULKAN_BACKEND_DIR"\/sd-vulkan/);
});

test("Windows launcher remains ASCII-safe for cmd.exe", () => {
  const launcher = fs.readFileSync(path.join(root, "windows.bat"));
  assert.equal([...launcher].some((byte) => byte > 0x7f), false);
});

test("Windows Vulkan setup repairs issue 10 runtime and RX 580 backend failures", () => {
  const setup = read("scripts/setup/setup.ps1");
  const server = read("scripts/server/serve.cjs");

  assert.match(setup, /https:\/\/aka\.ms\/vc14\/vc_redist\.x64\.exe/);
  assert.match(setup, /VCOMP140\.dll/);
  assert.match(setup, /master-685-19bdfe2\/sd-master-19bdfe2-bin-win-vulkan-x64\.zip/);
  assert.match(setup, /\.backend-version/);

  assert.match(server, /backendName === "vulkan"[\s\S]*?getPreferredVulkanBackendName\(\)/);
  assert.match(server, /0xC0000135/);
  assert.match(server, /Microsoft Visual C\+\+ runtime/);
});

test("Windows setup repairs issue 44 illegal instructions and RTX 50 CUDA runtime", () => {
  const setup = read("scripts/setup/setup.ps1");
  const server = read("scripts/server/serve.cjs");

  assert.match(setup, /master-782-b290693\/sd-master-b290693-bin-win-cuda12-x64\.zip/);
  assert.match(setup, /master-782-b290693\/cudart-sd-bin-win-cu12-x64\.zip/);
  assert.match(setup, /master-782-b290693\/sd-master-b290693-bin-win-cpu-x64\.zip/);
  assert.doesNotMatch(setup, /cudart-llama-bin-win-cuda-12\.4-x64/);

  assert.match(server, /3221225501/);
  assert.match(server, /0xC000001D: illegal CPU instruction/);
  assert.match(server, /runtime-dispatched Windows backend/);
});

test("Kokoro setup uses pinned online dependencies and skips optional CUDA payloads", () => {
  for (const relativePath of ["scripts/setup/setup-tts.ps1", "scripts/setup/setup-tts.sh"]) {
    const setup = read(relativePath);
    assert.match(setup, /ONNXRUNTIME_NODE_INSTALL_CUDA/);
    assert.match(setup, /prefer-online/);
    assert.match(setup, /\bci\b/);
    assert.doesNotMatch(setup, /prefer-offline/);
  }
});

test("model imports retry locked files and explain large-drive failures", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function withFileRetrySync/);
  assert.match(server, /function replaceFileWithRetry/);
  assert.match(server, /fs\.openSync\(tempPath, "w"\)/);
  assert.match(server, /FAT32 files are limited to 4 GB/);
  assert.match(server, /ensureStorageCapacity\(targetDir/);
});

test("CoreML setup installs and validates PyTorch", () => {
  const setup = read("scripts/setup/setup-coreml-npu.sh");
  assert.match(setup, /pip install torch/);
  assert.match(setup, /import torch/);
});

test("image generator exposes the wired negative prompt", () => {
  const generator = read("app/frontend/src/components/Generator.jsx");
  assert.match(generator, />Negative prompt</);
  assert.match(generator, /value=\{negativePrompt\}/);
  assert.match(generator, /setNegativePrompt\(e\.target\.value\)/);
});

test("text chat accepts document attachments without requiring a vision model", () => {
  const chat = read("app/frontend/src/components/TextChat.jsx");
  assert.match(chat, /disabled=\{!status\.ready \|\| isBusy\}/);
  assert.match(chat, /type: "document"/);
  assert.match(chat, /if \(!supportsVision\)[\s\S]*?Vision Model Required/);
});

test("issue 90: llama.cpp backend updates on release bumps and mllama fails with a clear message", () => {
  const ps1 = read("scripts/setup/setup-llama.ps1");
  const sh = read("scripts/setup/setup-llama.sh");
  const server = read("scripts/server/serve.cjs");

  assert.match(ps1, /\.llama-release/);
  assert.match(sh, /\.llama-release/);
  assert.match(server, /readGgufArchitecture/);
  assert.match(server, /mllama/);
  assert.match(server, /describeLlmProbeFailure/);
  assert.match(server, /failures\.length === 0 \? \{ preferredBackend/);
});

test("issue 84: in-app CUDA image backend download also installs the CUDA runtime", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /runtimeUrl: "https:\/\/github\.com\/leejet\/stable-diffusion\.cpp\/releases\/download\/master-782-b290693\/cudart-sd-bin-win-cu12-x64\.zip"/);
  assert.match(server, /startImageBackendDownload\(backend\.id, 0, "", "runtime"\)/);
});

test("issue 96: model downloads reject repository pages and HTML responses", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function getModelDownloadUrlIssue/);
  assert.match(server, /Hugging Face repository page, not a model file/);
  assert.match(server, /content-type"\] \|\| ""\)\.toLowerCase\(\)\.includes\("text\/html"\)/);
});

test("issue 85: chat shows reasoning, scrolls only the message list, renders tables, math and PDFs", () => {
  const chat = read("app/frontend/src/components/TextChat.jsx");
  assert.doesNotMatch(chat, /<ThinkingBlock/);
  assert.match(chat, /<ChatThinkingSection/);
  assert.match(chat, /"<think>"/);
  assert.doesNotMatch(chat, /\.scrollIntoView\(/);
  assert.match(chat, /type: "table"/);
  assert.match(chat, /katex\.renderToString/);
  assert.match(chat, /extractPdfText/);
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /async function planWebSearchQuery/);
});

test("issue 82: speech upload converts any browser-decodable audio to 16 kHz WAV", () => {
  const speech = read("app/frontend/src/components/SpeechTranscriber.jsx");
  assert.match(speech, /convertAudioFileTo16kWav/);
  assert.doesNotMatch(speech, /V1 accepts WAV files only/);
  assert.match(read("scripts/server/serve.cjs"), /readBinaryBody\(req, limitBytes = 1024 \* 1024 \* 1024\)/);
});

test("issue 87: vision catalog models ship matching projectors and never borrow another model's", () => {
  const manager = read("app/frontend/src/components/ModelManager.jsx");
  assert.match(manager, /mmproj-Qwen2\.5-VL-3B-Instruct-Q8_0\.gguf/);
  assert.match(manager, /mmproj-Qwen2\.5-VL-7B-Instruct-Q8_0\.gguf/);
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /lower\.includes\("qwen2\.5-vl"\)/);
  assert.doesNotMatch(server, /lower === "mmproj-model-f16\.gguf" \|\| lower\.includes\("mmproj"\)/);
});

test("issue 86: image backend validation keeps the real failure reason", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /amdgpu\.si_support=1/);
  assert.match(server, /build_from_source\.sh/);
  assert.doesNotMatch(server, /In-app backend downloads are currently available for Windows image backends\./);
});

test("launchers update a stale llama.cpp backend so existing installs get backend fixes", () => {
  assert.match(read("mac.sh"), /scripts\/setup\/update-llama\.sh/);
  assert.match(read("linux.sh"), /scripts\/setup\/update-llama\.sh/);
  assert.match(read("windows.bat"), /scripts\\setup\\update-llama\.ps1/);
  const sh = read("scripts/setup/update-llama.sh");
  assert.match(sh, /\.llama-release/);
  assert.match(sh, /setup-llama\.sh/);
  const ps1 = read("scripts/setup/update-llama.ps1");
  assert.match(ps1, /\.llama-release/);
  assert.match(ps1, /setup-llama\.ps1/);
  // The release the updater compares against must be the one setup-llama actually installs.
  assert.match(read("scripts/setup/setup-llama.sh"), /^RELEASE="\$\{LLAMA_RELEASE:-b\d+\}"$/m);
  assert.match(read("scripts/setup/setup-llama.ps1"), /param\(\[string\]\$Release = "b\d+"\)/);
});

function loadDownloadGuardFunctions() {
  const source = read("scripts/server/serve.cjs");
  const start = source.indexOf("function sanitizeDownloadFilename");
  const end = source.indexOf("function getModelDownloadUrlIssue");
  const snippet = source.slice(start, end);
  const pathInside = (childPath, parentPath) => {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const evaluate = new Function("path", "fs", "net", "spawnSync", "console", "pathInside", `${snippet}; return { sanitizeDownloadFilename, isPrivateOrLocalHost, validateZipArchiveEntries };`);
  return evaluate(path, fs, require("node:net"), spawnSync, console, pathInside);
}

function createZipArchive(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-guard-"));
  const zipPath = path.join(dir, "payload.zip");
  const python = `
import json, stat, sys, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for item in entries:
        if item.get('type') == 'symlink':
            info = zipfile.ZipInfo(item['name'])
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, item['target'])
        else:
            zf.writestr(item['name'], item.get('data', ''))
`;
  const result = spawnSync("python3", ["-c", python, zipPath, JSON.stringify(entries)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "zip creation failed");
  return zipPath;
}

test("download guard rails reject malicious filenames and archive payloads", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function sanitizeDownloadFilename/);
  assert.match(server, /Only public model URLs are allowed/);
  assert.match(server, /function validateZipArchiveEntries/);
  assert.match(server, /Archive member escapes the extraction directory/);
  assert.match(server, /Archive contains symlinks and cannot be extracted safely/);
  assert.match(server, /spawnSync\("unzip", \["-q", destPath, "-d", stagingDir\]/);

  const { sanitizeDownloadFilename, isPrivateOrLocalHost, validateZipArchiveEntries } = loadDownloadGuardFunctions();
  assert.equal(sanitizeDownloadFilename("../../etc/passwd"), "passwd");
  assert.equal(isPrivateOrLocalHost("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("::ffff:8.8.8.8"), false);

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "download-guard-validate-"));
  const goodArchive = createZipArchive([
    { name: "safe/model.gguf", data: "valid-model" },
    { name: "nested/extra.txt", data: "extra" },
  ]);
  const traversalArchive = createZipArchive([
    { name: "safe/model.gguf", data: "valid-model" },
    { name: "../escape.bin", data: "bad" },
  ]);
  const duplicateArchive = createZipArchive([
    { name: "dupe.bin", data: "first" },
    { name: "dupe.bin", data: "second" },
  ]);
  const symlinkArchive = createZipArchive([
    { name: "link.txt", type: "symlink", target: "../escape.bin" },
  ]);

  assert.doesNotThrow(() => validateZipArchiveEntries(goodArchive, stagingRoot));
  assert.throws(() => validateZipArchiveEntries(traversalArchive, stagingRoot), /Archive member escapes the extraction directory/);
  assert.throws(() => validateZipArchiveEntries(duplicateArchive, stagingRoot), /Archive contains duplicate output paths/);
  assert.throws(() => validateZipArchiveEntries(symlinkArchive, stagingRoot), /Archive contains symlinks/);

  for (const archive of [goodArchive, traversalArchive, duplicateArchive, symlinkArchive]) {
    try { fs.rmSync(archive, { force: true }); } catch (_) {}
  }
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (_) {}
});
