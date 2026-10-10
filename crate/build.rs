/*!
Embeds the small FFmpeg built for the system this build is for.

1. Cargo names that system in `TARGET`, as a Rust target triple, such as
   `x86_64-pc-windows-msvc` for Windows on x64 or `aarch64-apple-darwin` for a
   Mac with Apple silicon.
2. `ffmpeg.json` names the release and pins one SHA-256 per triple. The Release
   Pipeline writes it into the commit a release tag points at, so only a
   dependency on a release tag has one.
3. The release holds one file per triple, `ffmpeg-<triple>`, with `.exe` on
   Windows. It is downloaded into this build's own folder once and checked
   against its digest on every build.

`ANISPHERE_FFMPEG` names a file to embed instead, which is how a build without
network, such as Nix's, brings its own. Without a file to embed the build stops,
since the program saves no episode without one.
*/

use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

fn main() {
    println!("cargo::rerun-if-changed=ffmpeg.json");
    println!("cargo::rerun-if-env-changed=ANISPHERE_FFMPEG");
    match embedded() {
        Ok(path) => println!(
            "cargo::rustc-env=ANISPHERE_FFMPEG_BINARY={}",
            path.display()
        ),
        Err(error) => println!("cargo::error={error}"),
    }
}

/** The file to embed: the one `ANISPHERE_FFMPEG` names, else the release's build for this system. */
fn embedded() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ANISPHERE_FFMPEG").map(PathBuf::from) {
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "ANISPHERE_FFMPEG names {}, which is not a file",
                path.display()
            ))
        };
    }
    let text = std::fs::read_to_string("ffmpeg.json").map_err(|error| {
        format!("ffmpeg.json cannot be read ({error}), depend on a release tag of the FFmpeg repository")
    })?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("ffmpeg.json is not valid JSON: {error}"))?;

    // The system this build is for, as Cargo names it, such as x86_64-pc-windows-msvc.
    let target = std::env::var("TARGET").map_err(|_| "Cargo named no target".to_string())?;
    let digest = manifest["sha256"][&target]
        .as_str()
        .ok_or_else(|| format!("ffmpeg.json pins no ffmpeg build for {target}"))?;
    let field = |key: &str| manifest[key].as_str().unwrap_or_default().to_string();
    fetched(
        &field("repository"),
        &field("release"),
        &file_name(&target),
        digest,
    )
}

/**
 * The release's file for a target triple, such as
 * `ffmpeg-x86_64-pc-windows-msvc.exe` or `ffmpeg-aarch64-apple-darwin`.
 */
fn file_name(target: &str) -> String {
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    format!("ffmpeg-{target}{extension}")
}

/**
 * The release's file `name`, downloaded into this build's own folder once and
 * checked against `digest` each time.
 */
fn fetched(repository: &str, release: &str, name: &str, digest: &str) -> Result<PathBuf, String> {
    let out = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR is not set")?).join(name);
    if matches(&out, digest) {
        return Ok(out);
    }
    let staging = out.with_extension("part");
    // A tag such as 9.0.2+2.0.0 carries a plus, which a URL path writes as %2B.
    let tag = release.replace('+', "%2B");
    let url = format!("https://github.com/{repository}/releases/download/{tag}/{name}");
    let downloaded = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--location"])
        .args(["--retry", "2", "--output"])
        .arg(&staging)
        .arg(&url)
        .status()
        .is_ok_and(|status| status.success());
    let problem = if !downloaded {
        Some("could not be fetched")
    } else if !matches(&staging, digest) {
        Some("does not match the digest in ffmpeg.json")
    } else {
        None
    };
    if let Some(problem) = problem {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("{url} {problem}"));
    }
    std::fs::rename(&staging, &out)
        .map_err(|error| format!("{} cannot be written: {error}", out.display()))?;
    Ok(out)
}

/** Whether the file at `path` exists and has this SHA-256. */
fn matches(path: &Path, digest: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| {
        let found: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        found == digest
    })
}
