/*!
Builds the small FFmpeg AniSphere embeds, and everything its release carries.

  node build.mjs plan                  checks the source, names the release
  node build.mjs build <target> ...    builds each Rust target triple into dist/
  node build.mjs publish               SHA256SUMS, the notes and the crate's digests

FFMPEG_VERSION and ANISPHERE_VERSION name the FFmpeg release to build and the
AniSphere release it is for, as the pipeline's two fields set them.
options.json holds the FFmpeg signing key and the configure options. Inside
GitHub Actions each command also writes its part of the run's summary page.
*/

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, join } from 'node:path'

const root = import.meta.dirname
const work = join(root, 'work')
const dist = join(root, 'dist')
const options = JSON.parse(readFileSync(join(root, 'options.json'), 'utf8'))

/** The largest build AniSphere takes, so the program it sits in stays small. */
const BUDGET = 5_000_000

// Platforms

const windows = arch => ({
  exe: 'ffmpeg.exe',
  cc: `${arch}-w64-mingw32-gcc`,
  strip: `${arch}-w64-mingw32-strip`,
  flags: [
    '--target-os=mingw32',
    `--arch=${arch}`,
    '--enable-cross-compile',
    `--cross-prefix=${arch}-w64-mingw32-`,
    '--extra-ldflags=-static',
  ],
})

const linux = {
  exe: 'ffmpeg',
  cc: 'cc',
  strip: 'strip',
  flags: ['--extra-ldflags=-static', '--pkg-config-flags=--static'],
}

const mac = (arch, minimum) => ({
  exe: 'ffmpeg',
  cc: 'clang',
  strip: 'strip',
  flags: [
    '--target-os=darwin',
    `--arch=${arch}`,
    '--enable-cross-compile',
    '--cc=clang',
    `--extra-cflags=-arch ${arch} -mmacosx-version-min=${minimum}`,
    `--extra-ldflags=-arch ${arch} -mmacosx-version-min=${minimum}`,
  ],
})

/**
 * Every build a release carries, by Rust target triple. Windows is
 * cross-compiled with llvm-mingw on Linux, Linux is linked statically on a
 * machine of its own architecture, and macOS is built on an Intel Mac for both
 * architectures.
 *
 * The triple names the Rust target of the program that embeds the build, since
 * that is how the crate picks its file. It does not name the toolchain FFmpeg
 * is compiled with: both Windows builds come from llvm-mingw, linked statically
 * into a standalone program, and serve an MSVC-built AniSphere all the same.
 */
const PLATFORMS = {
  'x86_64-pc-windows-msvc': { name: 'Windows x64', ...windows('x86_64') },
  'aarch64-pc-windows-msvc': { name: 'Windows ARM64', ...windows('aarch64') },
  'x86_64-unknown-linux-gnu': { name: 'Linux x64', ...linux },
  'aarch64-unknown-linux-gnu': { name: 'Linux ARM64', ...linux },
  'aarch64-apple-darwin': { name: 'macOS Apple silicon', ...mac('arm64', '11.0') },
  'x86_64-apple-darwin': { name: 'macOS Intel', ...mac('x86_64', '10.15') },
}

const fileOf = target => `ffmpeg-${target}${PLATFORMS[target].exe.endsWith('.exe') ? '.exe' : ''}`

// Commands

/** Checks the source before anything is built, hands the tag to later jobs and describes the release. */
async function plan() {
  const { tag, title } = release()
  const { digest } = await source()
  console.log(tag)
  output('tag', tag)
  output('title', title)
  const targets = Object.entries(PLATFORMS).map(
    ([target, platform]) => `| ${platform.name} | \`${target}\` | \`${fileOf(target)}\` |`,
  )
  summary(`# ${title}

Release \`${tag}\`, every build checked against a budget of ${megabytes(BUDGET)}.

| Source | |
|---|---|
| Tarball | [${basename(release().source)}](${release().source}) |
| SHA-256 | \`${digest}\` |
| Signed by | \`${options.signingKey}\` |

### Builds

| Platform | Target | File |
|---|---|---|
${targets.join('\n')}

### What it holds

${components()}
`)
}

/** Builds every target named on the command line. */
async function build(targets) {
  if (targets.length === 0) throw new Error(`name a target: ${Object.keys(PLATFORMS).join(', ')}`)
  const unknown = targets.filter(target => !PLATFORMS[target])
  if (unknown.length > 0) throw new Error(`no build is defined for ${unknown.join(', ')}`)
  release()
  const { tarball } = await source()
  for (const target of targets) compile(target, tarball)
}

/**
 * Writes SHA256SUMS, options.json and the release notes once dist/ holds every
 * build, and the crate's ffmpeg.json and version for the commit the tag points at.
 */
async function publish() {
  const { ffmpeg, anisphere, tag, title, source: url } = release()
  const missing = Object.keys(PLATFORMS).filter(target => !existsSync(join(dist, fileOf(target))))
  if (missing.length > 0) throw new Error(`dist/ lacks the builds for ${missing.join(', ')}`)

  const builds = Object.entries(PLATFORMS).map(([target, platform]) => {
    const bytes = readFileSync(join(dist, fileOf(target)))
    return { target, platform, file: fileOf(target), size: bytes.length, digest: sha256(bytes) }
  })
  const sums = builds.map(({ digest, file }) => `${digest}  ${file}\n`).join('')
  writeFileSync(join(dist, 'SHA256SUMS'), sums)
  const { digest } = await source()
  const built = { ffmpeg, anisphere, source: url, sha256: digest, ...options }
  writeFileSync(join(dist, 'options.json'), `${JSON.stringify(built, null, 2)}\n`)

  const repository = process.env.GITHUB_REPOSITORY ?? 'AniSphereDevelopment/FFmpeg'
  const crate = join(root, 'crate')
  const digests = Object.fromEntries(builds.map(build => [build.target, build.digest]))
  const pinned = { repository, release: tag, sha256: digests }
  writeFileSync(join(crate, 'ffmpeg.json'), `${JSON.stringify(pinned, null, 2)}\n`)
  // Cargo wants three numbers, so FFmpeg 9.0 becomes 9.0.0, and the AniSphere release rides along.
  const version = `${[...ffmpeg.split('.'), '0', '0'].slice(0, 3).join('.')}+${anisphere}`
  const manifest = join(crate, 'Cargo.toml')
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`))

  const link = file => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${file}`
  const rows = builds.map(
    ({ platform, file, size }) => `| ${platform.name} | [\`${file}\`](${link(file)}) | ${megabytes(size)} |`,
  )
  const notes = `FFmpeg **${ffmpeg}**, built for **AniSphere ${anisphere}**. The small FFmpeg the program carries inside itself to save episodes, with no network code and no GPL part.

| Platform | File | Size |
|---|---|---|
${rows.join('\n')}

### Use it from Rust

\`\`\`toml
anisphere-ffmpeg = { git = "https://github.com/${repository}", tag = "${tag}" }
\`\`\`

The tag's commit pins the digest of every build, and the crate embeds the one for the target it is compiled for.

### Verify

\`\`\`sh
sha256sum -c SHA256SUMS
\`\`\`

<details><summary>SHA-256 of every build</summary>

\`\`\`
${sums}\`\`\`

</details>

### What it holds

${components()}

### Source and license

Built from [${basename(url)}](${url}), SHA-256 \`${digest}\`, its signature by the FFmpeg release key \`${options.signingKey}\` checked before every build, with the options in \`options.json\`. FFmpeg is licensed under the GNU Lesser General Public License 2.1 or later.
`
  writeFileSync(join(root, 'notes.md'), notes)
  summary(`# ${title}\n\n${notes}`)
  process.stdout.write(sums)
}

// Source

/** The FFmpeg and AniSphere releases this run is for, from the environment. */
function release() {
  const ffmpeg = process.env.FFMPEG_VERSION?.trim() ?? ''
  const anisphere = process.env.ANISPHERE_VERSION?.trim().replace(/^v/, '') ?? ''
  if (!/^\d+\.\d+(\.\d+)?$/.test(ffmpeg)) {
    throw new Error(`FFMPEG_VERSION must be an FFmpeg release such as 9.0.2, not "${ffmpeg}"`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(anisphere)) {
    throw new Error(`ANISPHERE_VERSION must be an AniSphere release such as 2.0.0, not "${anisphere}"`)
  }
  return {
    ffmpeg,
    anisphere,
    tag: `${ffmpeg}+${anisphere}`,
    title: `FFmpeg-${ffmpeg}+${anisphere}`,
    source: `https://ffmpeg.org/releases/ffmpeg-${ffmpeg}.tar.xz`,
  }
}

/** The FFmpeg source of the release, used only once its signature by the FFmpeg release key checks out. */
async function source() {
  const url = release().source
  mkdirSync(work, { recursive: true })
  const tarball = join(work, basename(url))
  const signature = `${tarball}.asc`
  const key = join(work, 'ffmpeg-devel.asc')
  if (!existsSync(tarball)) await download(url, tarball)
  await download(`${url}.asc`, signature)
  await download('https://ffmpeg.org/ffmpeg-devel.asc', key)

  // A home of its own, so only the FFmpeg key is known and no keyring of the machine matters.
  const home = join(work, 'gnupg')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { mode: 0o700 })
  const env = { GNUPGHOME: home }
  run('gpg', ['--batch', '--import', key], { env })
  let status = ''
  try {
    status = run('gpg', ['--batch', '--status-fd', '1', '--verify', signature, tarball], { env })
  } catch {
    // A bad signature fails gpg itself, and the check below says so.
  }
  /*
  Only the fields of a VALIDSIG line count, the key that made the signature and
  its primary key. Other status lines repeat the key's user ID, which whoever
  made the key chose freely.
  */
  const signers = status
    .split('\n')
    .filter(line => line.startsWith('[GNUPG:] VALIDSIG '))
    .flatMap(line => {
      const fields = line.split(' ')
      return [fields[2], fields.at(-1)]
    })
  if (!signers.includes(options.signingKey)) {
    rmSync(tarball, { force: true })
    throw new Error(`${basename(url)} is not signed by ${options.signingKey}`)
  }
  const digest = sha256(readFileSync(tarball))
  console.log(`source: ${basename(url)}, signed by ${options.signingKey}`)
  return { tarball, digest }
}

// Build

/** Configures, compiles and strips one target into dist/, and holds it to the budget. */
function compile(target, tarball) {
  const platform = PLATFORMS[target]
  const tree = join(work, target)
  rmSync(tree, { recursive: true, force: true })
  mkdirSync(tree, { recursive: true })
  run('tar', ['-xf', tarball, '--strip-components=1', '-C', tree])

  const started = performance.now()
  console.log(`${target}: configure`)
  const report = run('./configure', [...options.configure, ...platform.flags], {
    cwd: tree,
    log: join(tree, 'configure.log'),
  })
  // The release notes promise LGPL 2.1, which configure states once the options are read.
  if (!report.includes('License: LGPL version 2.1 or later')) {
    throw new Error(`${target}: configure no longer licenses the build under the LGPL 2.1, see configure.log`)
  }
  const configured = performance.now()
  console.log(`${target}: make`)
  run('make', [`-j${availableParallelism()}`, platform.exe], { cwd: tree, log: join(tree, 'make.log') })
  run(platform.strip, [platform.exe], { cwd: tree })
  const compiled = performance.now()

  mkdirSync(dist, { recursive: true })
  const file = fileOf(target)
  copyFileSync(join(tree, platform.exe), join(dist, file))
  const bytes = readFileSync(join(dist, file))
  const compiler = run(platform.cc, ['--version']).split('\n')[0].replace(/\s*\(.*$/, '')
  console.log(`${target}: ${file}, ${megabytes(bytes.length)}`)

  summary(`### ${platform.name}

| Target | \`${target}\` |
|---|---|
| File | \`${file}\` |
| Size | **${megabytes(bytes.length)}** \`${gauge(bytes.length)}\` |
| SHA-256 | \`${sha256(bytes)}\` |
| Configure | ${duration(configured - started)} |
| Compile | ${duration(compiled - configured)} |
| Compiler | ${compiler} |
`)
  if (bytes.length > BUDGET) {
    throw new Error(`${file} is ${megabytes(bytes.length)}, over the budget of ${megabytes(BUDGET)}`)
  }
}

/** What the build holds and leaves out, as a table read from the configure options. */
function components() {
  const parts = {
    protocol: 'Protocols',
    demuxer: 'Reads',
    muxer: 'Writes',
    parser: 'Parsers',
    bsf: 'Bitstream filters',
    decoder: 'Decoders',
    encoder: 'Encoders',
    filter: 'Filters',
  }
  const names = list => list.map(name => `\`${name}\``).join(' ')
  const rows = options.configure.flatMap(flag => {
    const [, part, list] = flag.match(/^--enable-(\w+)=(.+)$/) ?? []
    return parts[part] ? [`| ${parts[part]} | ${names(list.split(','))} |`] : []
  })
  const left = options.configure
    .flatMap(flag => flag.match(/^--disable-(\w+)$/)?.[1] ?? [])
    .filter(name => name !== 'everything' && name !== 'shared')
  return ['| Part | Names |', '|---|---|', ...rows, `| Left out | ${names(left)} |`].join('\n')
}

// Helpers

/** Runs a command, keeps its output in `log` when given, and fails with the end of it. */
function run(command, args, { cwd = root, log, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const said = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (log) writeFileSync(log, said)
  if (result.error) throw new Error(`${command}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed\n${said.trim().split('\n').slice(-25).join('\n')}`)
  }
  return result.stdout
}

async function download(url, file) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const megabytes = bytes => `${(bytes / 1e6).toFixed(2)} MB`

/** The size against the budget, as a bar of 24 cells and a percentage. */
function gauge(bytes) {
  const share = bytes / BUDGET
  const filled = Math.min(24, Math.round(share * 24))
  return `${'█'.repeat(filled)}${'░'.repeat(24 - filled)} ${Math.round(share * 100)} % of ${megabytes(BUDGET)}`
}

function duration(milliseconds) {
  const total = Math.round(milliseconds / 1000)
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`
}

/** Adds to the run's summary page inside GitHub Actions. */
function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

/** Hands a value to later jobs inside GitHub Actions. */
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

// Entry

const commands = { plan, build, publish }
const [command, ...rest] = process.argv.slice(2)
if (!commands[command]) {
  console.error('usage: node build.mjs plan | build <target> ... | publish')
  process.exit(1)
}
try {
  await commands[command](rest)
} catch (error) {
  console.error(error.message)
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${error.message.split('\n')[0]}`)
  process.exit(1)
}
