import React from 'react';

import { attachMemoryPressureListeners } from '@/lib/memory-pressure';

/**
 * Owns the desktop memory-pressure subscription for the lifetime of the app.
 *
 * The GTK shell dispatches `openchamber:memory-pressure` when the
 * WebKitWebProcess RSS crosses its warning threshold and recycles the process
 * right after a `critical` dispatch returns, so this must be mounted once, as
 * early as possible, and never per-pane.
 */
export const useMemoryPressureGuard = (): void => {
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return attachMemoryPressureListeners(window);
  }, []);
};
