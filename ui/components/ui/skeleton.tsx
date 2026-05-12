import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Loading placeholder. Drop in wherever a value is being fetched —
 * width/height come from className.
 *
 * Example:
 *   {loading ? <Skeleton className="h-6 w-32" /> : <span>{value}</span>}
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
