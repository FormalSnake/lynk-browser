# App-owned native code

Place platform native component sources here and register their shared-library outputs in `../nativedesktop.config.ts`.

- Build commands run with `ND_NATIVE_PACKAGE` set to the installed `@nativedesktop/native` root; reference its headers and helper sources through that variable, never via relative paths into a checkout.
- macOS components return `NSView`: compile `"$ND_NATIVE_PACKAGE/macos/NativeDesktopNative.swift"` with `-I "$ND_NATIVE_PACKAGE/macos"` (the `CNdPlugin` module), conform to `NativeDesktopView`, and register via `NativeDesktopPlugin`. SwiftUI can use `NativeDesktopSwiftUIView`.
- Linux components return `GtkWidget*` and build against GTK 4 with `-I "$ND_NATIVE_PACKAGE/include" -I "$ND_NATIVE_PACKAGE/linux"` (`nd_plugin.h`, `nd_native_gtk.h`).

`nd dev` and `nd build` run only the configured app-native command when its inputs are newer than its output. They do not rebuild NativeDesktop.
