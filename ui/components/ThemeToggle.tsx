'use client';
import { Moon, Sun, Laptop } from 'lucide-react';
import { useTheme, Theme } from './ThemeProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="切换主题" className="h-9 w-9">
          {resolved === 'dark'
            ? <Moon className="h-4 w-4" />
            : <Sun  className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]">
        {([
          ['light',  '浅色',  Sun],
          ['dark',   '深色',  Moon],
          ['system', '跟随系统', Laptop],
        ] as Array<[Theme, string, typeof Sun]>).map(([key, label, Icon]) => (
          <DropdownMenuItem
            key={key}
            onClick={() => setTheme(key)}
            className={theme === key ? 'bg-accent' : ''}
          >
            <Icon className="mr-2 h-4 w-4" />
            <span>{label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
