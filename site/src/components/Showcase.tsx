import { useEffect, useState } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { Platform, Shot } from "@/lib/shots"

type Item = { id: Platform; name: string; toolkit: string; shot: Shot }

export function Showcase({ items }: { items: Item[] }) {
  const [active, setActive] = useState<Platform>(items[0]!.id)

  // The head script already picked a platform from storage or the user agent.
  useEffect(() => {
    const picked = document.documentElement.dataset.platform as Platform | undefined
    if (picked && items.some((i) => i.id === picked)) setActive(picked)
  }, [items])

  function pick(value: unknown) {
    const id = value as Platform
    setActive(id)
    document.documentElement.dataset.platform = id
    localStorage.setItem("lynk-platform", id)
  }

  return (
    <Tabs value={active} onValueChange={pick} className="items-center gap-0">
      <div className="grid w-full grid-cols-[minmax(0,1fr)]">
        {items.map((item) => {
          const on = item.id === active
          return (
            <img
              key={item.id}
              src={item.shot.src}
              srcSet={item.shot.srcSet}
              sizes="(min-width: 1440px) 1360px, 94vw"
              width={item.shot.width}
              height={item.shot.height}
              alt={`Lynk on ${item.name} showing formalsnake.dev with tabs in the sidebar`}
              aria-hidden={!on}
              inert={!on}
              fetchPriority={on ? "high" : "low"}
              loading={on ? "eager" : "lazy"}
              decoding="async"
              className={cn(
                "col-start-1 row-start-1 h-auto w-full self-center rounded-xl outline outline-1 -outline-offset-1 outline-white/10",
                "shadow-[0_40px_120px_-20px_oklch(0.53_0.19_265/0.45),0_24px_48px_-12px_oklch(0_0_0/0.7)]",
                "transition-[opacity,filter,scale] duration-[420ms] ease-(--ease-out) motion-reduce:transition-opacity",
                on ? "scale-100 opacity-100 blur-none" : "pointer-events-none scale-[0.985] opacity-0 blur-sm motion-reduce:scale-100 motion-reduce:blur-none"
              )}
            />
          )
        })}
      </div>

      <TabsList
        aria-label="Platform"
        className="mt-7 h-10! rounded-full bg-[oklch(0.2_0.03_266/0.8)] p-1 shadow-[0_0_0_1px_oklch(1_0_0/0.08)] backdrop-blur-xl"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.id}
            value={item.id}
            className="rounded-full px-4 text-[0.9375rem] transition-[color,background-color] duration-150 data-active:bg-white/10!"
          >
            {item.name}
          </TabsTrigger>
        ))}
      </TabsList>

      {items.map((item) => (
        <TabsContent key={item.id} value={item.id} className="mt-4 text-center font-mono text-xs text-muted-foreground">
          {item.name} · window drawn by {item.toolkit} · page by Chromium
        </TabsContent>
      ))}
    </Tabs>
  )
}
