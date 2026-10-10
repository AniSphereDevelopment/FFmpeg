# AniSphere FFmpeg

The small FFmpeg [AniSphere](https://github.com/AniSphereDevelopment/AniSphere) carries inside its
program, built here and published as GitHub Releases, together with the `anisphere-ffmpeg` crate
that downloads the build for the target it is compiled for, checks it against the digest it pins,
and embeds it.

## What it holds

Only what saving an episode needs: reading MP4, MPEG-TS, Matroska and FLV, writing MP4 and WebVTT,
copying the picture, encoding sound to AAC from AAC, AC-3, E-AC-3, MP3, Opus, Vorbis or FLAC, and
moving subtitles between WebVTT, SubRip, ASS and the MP4 text track. It has no network code, and
it never encodes video, so it holds no GPL part. The full list is the `configure` field of
[`options.json`](options.json). A build is about 2.5 MB on Windows and 4 MB on Linux.

## Versions

A release is tagged `<ffmpeg>+<anisphere>`, such as `9.0.2+2.0.0`: the FFmpeg release it is built
from, and the AniSphere release it was first built for. A later AniSphere keeps using it until the
options change, and then the next AniSphere version names the new build.

| file | what it is |
|---|---|
| `ffmpeg-x86_64-pc-windows-msvc.exe` | Windows, x64 |
| `ffmpeg-aarch64-pc-windows-msvc.exe` | Windows, ARM64 |
| `ffmpeg-x86_64-unknown-linux-gnu` | Linux, x64, linked statically |
| `ffmpeg-aarch64-unknown-linux-gnu` | Linux, ARM64, linked statically |
| `ffmpeg-aarch64-apple-darwin` | macOS, Apple silicon |
| `ffmpeg-x86_64-apple-darwin` | macOS, Intel |
| `SHA256SUMS` | The digests, in the shape `sha256sum -c` reads |
| `options.json` | Both versions, the source's digest and the options it was built with |

Every build has to stay under 5 MB, or the pipeline stops.

## Building

Run the **Release Pipeline** workflow and fill in its two fields, the FFmpeg version and the
AniSphere version. It checks the FFmpeg source first, builds all six targets side by side and
publishes them, and its summary page shows each build's size, digest and timings. It refuses a
tag that already exists. `build.mjs` does every step and runs the same on your machine:

```
export FFMPEG_VERSION=9.0.2 ANISPHERE_VERSION=2.0.0
node build.mjs plan                              checks the source, names the release
node build.mjs build x86_64-unknown-linux-gnu    one or more targets into dist/
node build.mjs publish                           SHA256SUMS and the notes, once dist/ is full
```

It needs Node 24, `gpg`, a C compiler, `make`, and `nasm` for x64. Windows is cross-compiled on
Linux with [llvm-mingw](https://github.com/mstorsjo/llvm-mingw), Linux is built on a machine of its
own architecture, and macOS on an Intel Mac for both architectures. The source is the FFmpeg
release tarball from ffmpeg.org, and nothing is built from it unless its signature by the FFmpeg
release key `FCF986EA15E6E293A5644F10B4322F04D67658D8` checks out. `options.json` holds that key
and the configure options.

## The crate

[`crate/`](crate) holds `anisphere-ffmpeg`, and AniSphere depends on it by release tag:

```toml
anisphere-ffmpeg = { git = "https://github.com/AniSphereDevelopment/FFmpeg", tag = "9.0.2+2.0.0" }
```

The Release Pipeline writes `crate/ffmpeg.json`, the release and the SHA-256 of every build, and the
crate's version, such as `9.0.2+2.0.0`, into a commit beside `main`, and the tag points at that
commit. `main` itself carries no `ffmpeg.json`, so only a tag builds. Cargo.lock then pins the exact
commit, and with it the exact files. The build script downloads the file for the target being
compiled with curl and stops the build with an error when it cannot, or when the file does not
match its digest. `ANISPHERE_FFMPEG` names a file to embed instead, for builds without network such
as Nix's.

## A new version

1. Run the Release Pipeline with the FFmpeg version and the AniSphere version it is for.
2. In AniSphere, set the dependency's `tag` to the new release and run `cargo update -p
   anisphere-ffmpeg`.

## License

The build script, the crate and the workflow are under the MIT License, see [LICENSE](LICENSE). The builds are
FFmpeg, licensed under the GNU Lesser General Public License 2.1 or later. Its source is the
FFmpeg release tarball at [ffmpeg.org/releases](https://ffmpeg.org/releases/).
