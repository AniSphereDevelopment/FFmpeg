/*!
The small FFmpeg AniSphere carries inside its program, built in this repository
and fetched from its releases.

Each release tag points at a commit whose `ffmpeg.json` names the release and
pins the digest of every target's build, so a dependency on a tag fixes the
exact files. The build script fetches the one for the target being compiled,
and without it the build stops.
*/

/** The embedded build's executable. */
pub const BINARY: &[u8] = include_bytes!(env!("ANISPHERE_FFMPEG_BINARY"));
