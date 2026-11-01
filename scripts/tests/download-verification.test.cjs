const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const setup = path.resolve(__dirname, '../setup');
// Standard SHA-256 test vector for the literal text "abc", not a downloaded binary.
const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const fixtureUrl = 'https://example.invalid/release/fixture.tar.gz';
const read = (name) => fs.readFileSync(path.join(setup, name), 'utf8');

// Read only named function definitions. Never source or run an installation script.
function definition(file, name) {
  const match = read(file).match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${file}: ${name}`);
  return match[0];
}

function fixture(t, manifest = `${abcHash}  ${fixtureUrl}\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-verification-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(setup, 'download-verification.sh'), path.join(dir, 'helper.sh'));
  fs.writeFileSync(path.join(dir, 'linux-downloads.sha256'), manifest);
  fs.writeFileSync(path.join(dir, 'download'), 'previous verified file');
  const run = (body, env = {}) => spawnSync('bash', ['-c', `
    set -euo pipefail
    source "$TEST_DIR/helper.sh"
    curl() {
      printf '%s\\n' "$@" > "$TEST_DIR/curl.args"
      local output=''
      while (( $# )); do
        if [[ "$1" == '-o' ]]; then output="$2"; shift; fi
        shift
      done
      printf '%s' "\${TEST_PAYLOAD:-abc}" > "$output"
      return "\${TEST_CURL_STATUS:-0}"
    }
    ${body}
  `], {
    encoding: 'utf8',
    env: { ...process.env, TEST_DIR: dir, FIXTURE_URL: fixtureUrl, ...env },
  });
  return { dir, run, exists: (name) => fs.existsSync(path.join(dir, name)) };
}

test('verified download replaces destination only after matching the published expected hash', (t) => {
  const f = fixture(t);
  const result = f.run('download_verified "$FIXTURE_URL" "$TEST_DIR/download"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, 'download'), 'utf8'), 'abc');
  assert.equal(f.exists('download.part'), false);
  const args = fs.readFileSync(path.join(f.dir, 'curl.args'), 'utf8').trim().split('\n');
  assert.equal(args[0], '--disable'); // Ignore user curlrc, including insecure/rewrite options.
  for (const option of ['--proto', '--proto-redir']) {
    assert.equal(args[args.indexOf(option) + 1], '=https');
  }
});

for (const [name, env] of [
  ['checksum mismatch', { TEST_PAYLOAD: 'tampered' }],
  ['HTTP/download error after writing a partial file', { TEST_CURL_STATUS: '22' }],
]) {
  test(`${name} fails closed even in an if/&& context`, (t) => {
    const f = fixture(t);
    const result = f.run(`
      if download_verified "$FIXTURE_URL" "$TEST_DIR/download" && touch "$TEST_DIR/consumed"; then
        exit 99
      fi
    `, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.exists('consumed'), false);
    assert.equal(f.exists('download.part'), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'download'), 'utf8'), 'previous verified file');
  });
}

for (const [name, manifest] of [
  ['missing hash', '# no reviewed entry\n'],
  ['malformed hash', `xyz  ${fixtureUrl}\n`],
  ['duplicate hash', `${abcHash}  ${fixtureUrl}\n${abcHash}  ${fixtureUrl}\n`],
  ['extra fields', `${abcHash}  ${fixtureUrl} unexpected\n`],
  ['different release URL', `${abcHash}  https://example.invalid/other/fixture.tar.gz\n`],
]) {
  test(`${name} rejects before curl and clears stale partials`, (t) => {
    const f = fixture(t, manifest);
    fs.writeFileSync(path.join(f.dir, 'download.part'), 'stale');
    const result = f.run('download_verified "$FIXTURE_URL" "$TEST_DIR/download"');
    assert.notEqual(result.status, 0);
    assert.equal(f.exists('curl.args'), false);
    assert.equal(f.exists('download.part'), false);
  });
}

test('missing manifest or insecure URL never reaches curl', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'linux-downloads.sha256'));
  assert.notEqual(f.run('download_verified "$FIXTURE_URL" "$TEST_DIR/download"').status, 0);
  assert.notEqual(f.run('download_verified http://example.invalid/file "$TEST_DIR/download"').status, 0);
  assert.equal(f.exists('curl.args'), false);
});

test('no hash utility rejects before download', (t) => {
  const f = fixture(t);
  const result = f.run(`
    command() {
      if [[ "$1" == -v && ( "$2" == sha256sum || "$2" == shasum ) ]]; then return 1; fi
      builtin command "$@"
    }
    download_verified "$FIXTURE_URL" "$TEST_DIR/download"
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires sha256sum or shasum/);
  assert.equal(f.exists('curl.args'), false);
});

test('hash utility failure cannot be mistaken for a match', (t) => {
  const f = fixture(t);
  const result = f.run(`
    sha256sum() { printf '%s  -\\n' '${abcHash}'; return 1; }
    if download_verified "$FIXTURE_URL" "$TEST_DIR/download"; then exit 99; fi
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.exists('download.part'), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'download'), 'utf8'), 'previous verified file');
});

test('shasum fallback verifies SHA-256 when sha256sum is absent', (t) => {
  const f = fixture(t);
  const result = f.run(`
    command() {
      if [[ "$1" == -v && "$2" == sha256sum ]]; then return 1; fi
      builtin command "$@"
    }
    shasum() {
      [[ "$1" == -a && "$2" == 256 ]] || return 1
      builtin command sha256sum
    }
    download_verified "$FIXTURE_URL" "$TEST_DIR/download"
  `);
  assert.equal(result.status, 0, result.stderr);
});

for (const backend of ['llama', 'whisper']) {
  for (const failure of ['tampered', 'unknown-release']) {
    test(`${backend}: ${failure} does not extract, chmod, or erase the installed backend`, (t) => {
      const release = 'fixture-release';
      const url = `https://github.com/ggml-org/${backend}.cpp/releases/download/${release}/fixture.tar.gz`;
      const f = fixture(t, `${abcHash}  ${url}\n`);
      fs.mkdirSync(path.join(f.dir, 'backend'));
      fs.writeFileSync(path.join(f.dir, 'backend', 'keep'), 'old backend');
      const result = f.run(`
        ${definition(`setup-${backend}.sh`, 'download_and_extract')}
        PLATFORM=Linux
        RELEASE='${failure === 'unknown-release' ? 'unreviewed' : release}'
        TOOLS_DIR="$TEST_DIR"
        SCRIPT_DIR="$TEST_DIR"
        python3() { touch "$TEST_DIR/extracted"; }
        tar() { touch "$TEST_DIR/extracted"; }
        chmod() { touch "$TEST_DIR/chmodded"; }
        if download_and_extract fixture.tar.gz "$TEST_DIR/backend"; then exit 99; fi
      `, { TEST_PAYLOAD: failure === 'tampered' ? 'bad' : 'abc' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.exists('extracted'), false);
      assert.equal(f.exists('chmodded'), false);
      assert.equal(f.exists('fixture.tar.gz.part'), false);
      assert.equal(f.exists('backend/keep'), true);
      if (failure === 'unknown-release') assert.equal(f.exists('curl.args'), false);
    });
  }
}

test('optional llama wrapper preserves old backend after verification failure', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'backend'));
  fs.writeFileSync(path.join(f.dir, 'backend', 'keep'), 'old backend');
  const result = f.run(`
    ${definition('setup-llama.sh', 'download_and_extract')}
    ${definition('setup-llama.sh', 'download_and_extract_optional')}
    PLATFORM=Linux RELEASE=unknown TOOLS_DIR="$TEST_DIR" SCRIPT_DIR="$TEST_DIR"
    download_and_extract_optional fixture.tar.gz "$TEST_DIR/backend" test
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.exists('backend/keep'), true);
  assert.equal(f.exists('curl.args'), false);
});

test('setup download wrapper prevents CUDA consumers when the CLI download fails verification', (t) => {
  const f = fixture(t);
  const result = f.run(`
    ${definition('setup.sh', 'download_file')}
    PLATFORM=Linux
    print_info() { :; }; print_ok() { :; }; print_fail() { :; }; format_bytes() { :; }
    if download_file "$FIXTURE_URL" "$TEST_DIR/server" server &&
       TEST_PAYLOAD=bad download_file "$FIXTURE_URL" "$TEST_DIR/cli" cli; then
      touch "$TEST_DIR/executed"
    fi
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.exists('executed'), false);
  assert.equal(f.exists('server'), true);
  assert.equal(f.exists('cli'), false);
  assert.equal(f.exists('cli.part'), false);
});

test('all 15 currently selected Linux release assets have unique well-formed pins', () => {
  const pins = read('linux-downloads.sha256').split('\n').filter((line) => line && !line.startsWith('#'));
  const urls = pins.map((line) => {
    assert.match(line, /^[0-9a-f]{64}  https:\/\/\S+$/);
    return line.split('  ')[1];
  });
  assert.equal(new Set(urls).size, 15);
  assert.equal(urls.length, 15);
  const main = read('setup.sh');
  const sdRelease = main.match(/^SD_RELEASE="([^"]+)"/m)[1];
  const sdHash = sdRelease.split('-').at(-1);
  const nodeVersion = main.match(/^NODE_VERSION="([^"]+)"/m)[1];
  const expected = [`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`];
  for (const suffix of ['', '-vulkan', '-rocm-7.13.0']) {
    expected.push(`https://github.com/leejet/stable-diffusion.cpp/releases/download/${sdRelease}/sd-master-${sdHash}-bin-Linux-Ubuntu-24.04-x86_64${suffix}.zip`);
  }
  for (const backend of ['llama', 'whisper']) {
    const script = read(`setup-${backend}.sh`);
    const release = script.match(/^RELEASE="\$\{\w+:-([^}]+)\}"/m)[1];
    for (const match of script.matchAll(/"((?:llama|whisper)-[^"\n]*ubuntu[^"\n]+\.tar\.gz)"/g)) {
      expected.push(`https://github.com/ggml-org/${backend}.cpp/releases/download/${release}/${match[1].replace('$RELEASE', release)}`);
    }
    assert.match(script, /source "\$SCRIPT_DIR\/download-verification\.sh"/);
  }
  expected.push(...Array.from(main.matchAll(/PREBUILT(?:_CLI)?_URL="([^"]+)"/g), (m) => m[1]));
  assert.deepEqual(urls.sort(), expected.sort());
  assert.match(main, /source "\$SCRIPT_DIR\/download-verification\.sh"/);
});
