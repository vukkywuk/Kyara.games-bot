/** Actions offered by the desktop app (desktop/preload.ts); null in a normal browser. */
export interface KyaraDesktop {
  isDesktop: true;
  /** Opens the app's own window on kyara.games, where you log in yourself. */
  openKyara(): Promise<boolean>;
  getAutoStart(): Promise<boolean>;
  setAutoStart(on: boolean): Promise<boolean>;
  openDataFolder(): Promise<boolean>;
}

declare global {
  interface Window {
    kyaraDesktop?: KyaraDesktop;
  }
}

export const desktop: KyaraDesktop | null = typeof window !== 'undefined' && window.kyaraDesktop?.isDesktop ? window.kyaraDesktop : null;
