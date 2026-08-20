import { defineConfig } from "@nativedesktop/cli/config";

export default defineConfig({
  // Add app-owned native libraries here. See docs/native-components.md.
  // Build commands run with ND_NATIVE_PACKAGE set to the @nativedesktop/native
  // package root, for include paths and the Swift helper source.
  native: { plugins: [] },

  app: {
    id: "dev.nativebrowser.NativeBrowser",
    name: "NativeBrowser",
    displayName: "NativeBrowser",
    version: "0.1.0",
    categories: ["Network", "WebBrowser"],
    // Layered, so one piece of art dresses both platforms: macOS 26 gets the
    // Icon Composer bundle with the glass body, and the same composition
    // flattens to the SVG Linux installs into hicolor.
    icon: {
      layered: {
        background: { gradient: ["#2B2ED8", "#7A2AD8"] },
        layers: ["assets/compass.svg"],
      },
    },
  },

  // Chromium on both platforms: the extension broker runs on CDP, and
  // chrome-extension:// is Chromium's own, so extension pages are served from
  // nbext:// (src/extensions/scheme.ts). A scheme is only standard, secure and
  // CORS-enabled if every process was told about it before cef_initialize,
  // which is why it is declared here rather than registered at runtime.
  webview: {
    engine: { mac: "chromium", linux: "chromium" },
    cef: { schemes: ["nbext"] },
  },

  // Packaging (`nd package [mac|linux]`). Defaults: entry "src/main.tsx",
  // compile "auto" (runs the `compile` script when declared), outDir "dist",
  // no updates (opt in with package.updates).
});
