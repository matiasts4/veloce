import { type InvokeArgs } from '@tauri-apps/api/core';

export const isTauri = () => {
    return typeof window !== 'undefined' && 'isTauri' in window;
};

// Safe wrapper for Tauri invoke
export async function safeInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T | null> {
    // Check if running in browser/server vs Tauri window
    // In Tauri v2, we rely on the import resolution or specific window flags if needed.
    // Using dynamic import to prevent SSR crashes.
    if (typeof window === 'undefined') return null;

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<T>(cmd, args);
    } catch (err) {
        // Suppress "not in tauri" errors or import failures in standard browser
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[SafeInvoke] Failed to invoke '${cmd}'. Are you in the browser?`, err);
        }
        return null;
    }
}
