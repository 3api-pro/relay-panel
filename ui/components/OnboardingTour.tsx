"use client";
import { useEffect } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";

const STORAGE_KEY = "3api_tour_done_v1";

interface Props {
  /** When true, start the tour immediately on mount (gated by localStorage). */
  autoStart?: boolean;
  /** When true, force the tour regardless of the seen-flag. */
  force?: boolean;
}

export function OnboardingTour({ autoStart = false, force = false }: Props) {
  useEffect(() => {
    if (!autoStart) return;
    if (typeof window === "undefined") return;
    if (!force && localStorage.getItem(STORAGE_KEY)) return;

    // Wait one tick so target elements are in the DOM after route transition.
    let cancelled = false;
    let d: Driver | null = null;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      d = driver({
        showProgress: true,
        allowClose: true,
        nextBtnText: "下一步",
        prevBtnText: "上一步",
        doneBtnText: "完成",
        progressText: "{{current}} / {{total}}",
        steps: [
          {
            element: '[data-tour="sidebar-plans"]',
            popover: {
              title: "套餐管理",
              description:
                "在这里创建和编辑卖给客户的套餐（Pro / Max5x 等）。我们已经默认 seed 了 4 个，你可以随时改价格或加新的。",
            },
          },
          {
            element: '[data-tour="sidebar-channels"]',
            popover: {
              title: "上游 Channel",
              description:
                "这里管理上游 LLM 服务。默认指向 llmapi.pro / wholesale（开箱即用），你也可以添加 BYOK 自己的 Anthropic 密钥。",
            },
          },
          {
            element: '[data-tour="sidebar-wholesale"]',
            popover: {
              title: "批发余额",
              description:
                "这是你向 3api 平台充值的余额。每卖出一单都会从这里扣除 face value。低于 ¥50 时我们会邮件提醒。",
            },
          },
          {
            element: '[data-tour="sidebar-branding"]',
            popover: {
              title: "品牌设置",
              description:
                "你的店铺 logo / 主色 / 公告 / 自定义域配置。终端客户看到的就是这些。",
            },
          },
          {
            element: '[data-tour="topbar-cmdk"]',
            popover: {
              title: "快速搜索",
              description:
                "随时按 Ctrl / Cmd + K 调起命令面板，可以跳到任何页面或快速执行常用操作。",
            },
          },
          {
            element: '[data-tour="topbar-theme"]',
            popover: {
              title: "主题切换",
              description: "浅色 / 深色 / 跟随系统。设置会自动保存在你的浏览器。",
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
      window.clearTimeout(t);
      try {
        d?.destroy();
      } catch {}
    };
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
