"use client";
import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";

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
  const t = useTranslations("admin.command_palette");
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
          aria-label={t("aria_label")}
          className={cn(
            "fixed left-1/2 top-[18%] z-[61] w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">{t("title")}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t("subtitle")}</DialogPrimitive.Description>

          <Command label={t("title")} className="flex h-full w-full flex-col">
            <div className="flex items-center border-b border-border px-3" cmdk-input-wrapper="">
              <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
              <Command.Input
                placeholder={t("input_placeholder")}
                className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              />
              <kbd className="ml-2 hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100 sm:flex">
                ESC
              </kbd>
            </div>

            <Command.List className="max-h-[420px] overflow-y-auto overflow-x-hidden p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                {t("no_match")}
              </Command.Empty>

              <Command.Group heading={t("group_nav")} className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin"))}>
                  {t("nav_dashboard")} <Shortcut>{t("nav_dashboard_short")}</Shortcut>
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/plans"))}>
                  {t("nav_plans")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/users"))}>
                  {t("nav_users")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/orders"))}>
                  {t("nav_orders")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/affiliate"))}>
                  {t("nav_affiliate")} <Shortcut>{t("nav_affiliate_short")}</Shortcut>
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/channels"))}>
                  {t("nav_channels")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/wholesale"))}>
                  {t("nav_wholesale")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/branding"))}>
                  {t("nav_branding")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/settings"))}>
                  {t("nav_settings")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/webhooks"))}>
                  {t("nav_webhooks")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/payment-config"))}>
                  {t("nav_payment_config")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/stats"))}>
                  {t("nav_stats")}
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading={t("group_action")} className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/plans?action=new"))}>
                  {t("action_new_plan")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/channels?action=new-key"))}>
                  {t("action_new_key")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/wholesale?action=topup"))}>
                  {t("action_topup")}
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading={t("group_appearance")} className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("light"))}>
                  {t("theme_light")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("dark"))}>
                  {t("theme_dark")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => setTheme("system"))}>
                  {t("theme_system")}
                </Command.Item>
              </Command.Group>

              <Command.Separator className="-mx-1 my-1 h-px bg-border" />

              <Command.Group heading={t("group_account")} className="overflow-hidden p-1 text-foreground">
                <Command.Item className={ItemBase} onSelect={() => run(() => router.push("/admin/settings#password"))}>
                  {t("account_password")}
                </Command.Item>
                <Command.Item className={ItemBase} onSelect={() => run(() => logout())}>
                  {t("account_logout")}
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
