# bun drives the build (`bun install`, `bun run compile`, `bunx nd package`); rust-toolchain.toml
# is resolved by rustup's proxies, which act on the name they run as.
RUST = ["cargo", "rustc", "rustdoc", "rustfmt", "cargo-fmt", "cargo-clippy", "clippy-driver"]

dev(
    packages = [
        pkg("bun"),
        pkg("rustup", links = {name: "rustup" for name in RUST}),
        # nd's CEF host builds CEF's C++ wrapper with CMake and Ninja.
        pkg("cmake"),
        pkg("ninja"),
    ],
    # The Linux host is GTK4.
    libs = [lib("gtk4")] if platform.is_linux else [],
    bins = [bin("pkg-config"), bin("gcc")] if platform.is_linux else [],
)
