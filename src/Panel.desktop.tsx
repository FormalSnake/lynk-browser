// A `.desktop.tsx` component — the NativeDesktop mirror of React Native's
// `.native.tsx`. It is an ordinary `.tsx` (TS/ESLint/Prettier/Bun handle it
// natively), so `import { Panel } from "./Panel.desktop"` resolves with no
// extension. Desktop UI lives here, visually separated from shared/web code;
// it renders to native GTK widgets, not the DOM.
//
// Note the split: hook state comes from a shared `.ts` hook (useToggle,
// authored `from "react"`), while this component imports nothing from raw
// "react". That is the convention — desktop components use
// `@nativedesktop/react` and shared hooks, so they keep full hot reload while
// the shared hook is rewritten and pinned underneath them.
import { useToggle } from "./hooks/useToggle.ts";

export function Panel(): React.ReactNode {
  const [open, toggle] = useToggle();
  return (
    <box orientation="vertical" spacing={8}>
      <label testID="panel-status" text={open ? "Panel: open" : "Panel: closed"} />
      <button testID="panel-toggle" label="Toggle panel" onClick={toggle} />
    </box>
  );
}
