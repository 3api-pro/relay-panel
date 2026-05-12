"use client";
import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "3api:command-palette:open";
export function openCommandPalette() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OPEN_EVENT));
  }
}

const ItemBase =
  "relative flex cursor-default select-none items-center rounded-sm px-2 py-2 text-sm outline-none " +
  "aria-selected:bg-accent aria-selected:text-accent-foreground " +
  "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50";

interface ShortcutProps extends React.HTMLAttributes<HTMLSpanElement> {}
function Shortcut({ className, ...props }: ShortcutProps) {
  return (
    <span
      className={cn("ml-auto text-[10px] tracking-wider text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme } = useTheme();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const openHandler = () => setOpen(true);
    document.addEventListener("keydown", down);
    window.addEventListener(OPEN_EVENT, openHandler);
    return () => {
      document.removeEventListener("keydown", down);
      window.removeEventListener(OPEN_EVENT, openHandler);
    };
  }, []);

  const run = useCallback((action: () => void) => {
    setOpen(false);
    setTimeout(action, 0);
  }, []);

  async function logout() {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
    } catch {}
    try {
      localStorage.removeItem("admin_token");
      localStorage.removeItem("admin_profile");
    } catch {}
    router.push("/admin/login");
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
        />
        <DialogPrimitive.Content
          aria-label="命令面板"
          className={cn(
            "fixed left-1/2 top-[18%] z-[61] w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">键入以搜索命令</DialogPrimitive.Description>

          <Command label="命令面板" className="flex h-full w-full flex-col">
            <div className="flex items-center border-b border-border px-3" cmdk-input-wrapper="">
              <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
              <Command.Input
                placeholder="搜索命令或页面…"
                className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              />
              <kbd className="ml-2 hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100 sm:flex">
                ESC
              </kbd>
            </div>

            <Command.List className="max-h-[420px] overflow-y-auto overflow-x-hidden p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                没有匹配的命令
              </Command.Empty>

              <Command.Group heading="导航" className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin"))}>
                  仪表盘 <Shortcut>总览</Shortcut>
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/plans"))}>
                  套餐管理
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/users"))}>
                  终端用户
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/orders"))}>
                  订单
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/channels"))}>
                  上游 Channel
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/wholesale"))}>
                  批发余额
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/branding"))}>
                  品牌设置
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/settings"))}>
                  账号设置
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/payment-config"))}>
                  收款配置
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/stats"))}>
                  数据统计
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading="操作" className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/plans?action=new"))}>
                  新建套餐
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/channels?action=new-key"))}>
                  添加上游 key
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/wholesale?action=topup"))}>
                  充值批发余额
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading="外观" className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("light"))}>
                  切换到浅色主题
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("dark"))}>
                  切换到深色主题
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("system"))}>
                  跟随系统主题
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading="账号" className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/settings#password"))}>
                  修改密码
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => logout())}>
                  登出
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
