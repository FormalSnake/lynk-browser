import { defineConfig } from "@nativedesktop/cli/config";

export default defineConfig({
  // Add app-owned native libraries here. See docs/native-components.md.
  // Build commands run with ND_NATIVE_PACKAGE set to the @nativedesktop/native
  // package root, for include paths and the Swift helper source.
  native: { plugins: [] },

  app: {
    id: "dev.formalsnake.Lynk",
    name: "Lynk Browser",
    displayName: "Lynk Browser",
    version: "0.1.0",
    categories: ["Network", "WebBrowser"],
    // Linux gets the elementary (Pantheon) style tile; macOS 26 gets the
    // skeuomorphic art as Icon Composer layers so the system can apply glass,
    // dark and tinted looks. Sources and prompts live in assets/icon.
    icon: {
      linux: "assets/icon/linux.png",
      layered: {
        background: "#0c1736",
        layers: [
          { image: "assets/icon/mac-background.png", specular: false, translucency: false, shadow: false },
          { image: "assets/icon/mac-foreground.png", specular: true, translucency: false, shadow: 0.5 },
        ],
      },
    },
  },

  // Chromium on both platforms.
  webview: {
    engine: { mac: "chromium", linux: "chromium" },
    cef: { style: "chrome" },
  },

  // Packaging (`nd package [mac|linux]`). Defaults: entry "src/main.tsx",
  // compile "auto" (runs the `compile` script when declared), outDir "dist",
  // no updates (opt in with package.updates).
  package: {
    // 1Password on macOS trusts a browser by its code signature; an ad-hoc
    // signature changes with every build and cannot be added as a browser.
    mac: { signIdentity: "Developer ID Application: CanaryCoders SL (8E7JB82GJK)" },
  },
});
