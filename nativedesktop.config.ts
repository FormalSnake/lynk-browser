import { defineConfig } from "@nativedesktop/cli/config";

export default defineConfig({
  // Add app-owned native libraries here. See docs/native-components.md.
  // Build commands run with ND_NATIVE_PACKAGE set to the @nativedesktop/native
  // package root — use it for include paths and the Swift helper source.
  native: { plugins: [] },

  // App identity: bundle id, product name, icon, version. Flows into the
  // macOS Info.plist and the Linux .desktop/AppImage at `nd package` time.
  // See docs/packaging.md.
  // app: {
  //   id: "com.example.myapp",
  //   name: "MyApp",
  //   displayName: "My App",
  //   version: "1.0.0",
  //   icon: { source: "assets/icon.png" },
  //   fileAssociations: [{ ext: "md", name: "Markdown Document", mimeType: "text/markdown" }],
  //   urlSchemes: [{ scheme: "myapp" }],
  // },

  // Packaging (`nd package [mac|linux]`). Defaults: entry "src/main.tsx",
  // compile "auto" (runs the `compile` script when declared), outDir "dist",
  // no updates (opt in with package.updates).
  // package: {
  //   updates: { baseUrl: "https://updates.example.com/myapp" },
  // },
});
