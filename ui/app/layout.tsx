import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { CommandPalette } from '@/components/CommandPalette';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = {
  title: '3API Panel',
  description: 'Open-source AI API reseller platform with built-in upstream',
};

const themeBootstrap = `(function(){try{var t=localStorage.getItem('theme')||'system';var r=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.classList.remove('light','dark');document.documentElement.classList.add(r);}catch(e){}})();`;

// Best-effort: pick the right <html lang> before React hydrates so the very
// first paint matches what the user prefers (avoids a flash of zh in en mode
// for users who set the cookie before).
const localeBootstrap = `(function(){try{var ck=document.cookie.split('; ').find(function(c){return c.indexOf('3api_locale=')===0;});var ls=null;try{ls=localStorage.getItem('3api_locale');}catch(_e){}var loc=ck?decodeURIComponent(ck.substring('3api_locale='.length)):ls;if(loc!=='zh'&&loc!=='en'){var nav=(navigator.language||'').toLowerCase();loc=nav.indexOf('en')===0?'en':'zh';}document.documentElement.lang=loc==='en'?'en':'zh-CN';}catch(e){}})();`;

export default function RootLayout({
  children,
}: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: localeBootstrap }} />
      </head>
      <body>
        <I18nProvider>
          <ThemeProvider defaultTheme="system">
            {children}
            <CommandPalette />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
