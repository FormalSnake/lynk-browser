// A shared, platform-agnostic hook — authored the normal way, `from "react"`,
// so the SAME file can be consumed by web and React-Native codebases. On the
// NativeDesktop side this `from "react"` is rewritten to `@nativedesktop/react`
// automatically: by babel-plugin-nativedesktop for `bun run compile`, and by
// its bun-plugin (bunfig.toml preload) for `bun --hot` dev. You do NOT rewrite
// it by hand. Because the dev-mode rewrite pins this module at first eval,
// editing this file needs a host restart to take effect (its consumers, the
// `.desktop.tsx` components, still hot-reload normally).
import { useState, useCallback } from "react";

export function useToggle(initial = false): [boolean, () => void] {
  const [on, setOn] = useState(initial);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return [on, toggle];
}
