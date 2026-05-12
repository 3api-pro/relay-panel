"use client";
import { useEffect } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { useTranslations } from "@/lib/i18n";

const STORAGE_KEY = "3api_tour_done_v1";

interface Props {
  /** When true, start the tour immediately on mount (gated by localStorage). */
  autoStart?: boolean;
  /** When true, force the tour regardless of the seen-flag. */
  force?: boolean;
}

export function OnboardingTour({ autoStart = false, force = false }: Props) {
  const t = useTranslations("admin.tour");
  useEffect(() => {
    if (!autoStart) return;
    if (typeof window === "undefined") return;
    if (!force && localStorage.getItem(STORAGE_KEY)) return;

    // Wait one tick so target elements are in the DOM after route transition.
    let cancelled = false;
    let d: Driver | null = null;
    const tt = window.setTimeout(() => {
      if (cancelled) return;
      d = driver({
        showProgress: true,
        allowClose: true,
        nextBtnText: t("next"),
        prevBtnText: t("prev"),
        doneBtnText: t("done"),
        progressText: t("progress"),
        steps: [
          {
            element: '[data-tour="sidebar-plans"]',
            popover: {
              title: t("step_plans_title"),
              description: t("step_plans_desc"),
            },
          },
          {
            element: '[data-tour="sidebar-channels"]',
            popover: {
              title: t("step_channels_title"),
              description: t("step_channels_desc"),
            },
          },
          {
            element: '[data-tour="sidebar-wholesale"]',
            popover: {
              title: t("step_wholesale_title"),
              description: t("step_wholesale_desc"),
            },
          },
          {
            element: '[data-tour="sidebar-branding"]',
            popover: {
              title: t("step_branding_title"),
              description: t("step_branding_desc"),
            },
          },
          {
            element: '[data-tour="topbar-cmdk"]',
            popover: {
              title: t("step_cmdk_title"),
              description: t("step_cmdk_desc"),
            },
          },
          {
            element: '[data-tour="topbar-theme"]',
            popover: {
              title: t("step_theme_title"),
              description: t("step_theme_desc"),
            },
          },
        ],
        onDestroyStarted: () => {
          try {
            localStorage.setItem(STORAGE_KEY, "1");
          } catch {}
          d?.destroy();
        },
      });
      d.drive();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(tt);
      try {
        d?.destroy();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, force]);

  return null;
}

/** Manual trigger helper — clears the seen-flag and re-runs. */
export function resetOnboardingTour() {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}
