/**
 * Exposes a few desktop-only actions to the app window (the local web app). No Node access,
 * no arbitrary IPC: four named calls, each re-checked in the main process.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kyaraDesktop', {
  isDesktop: true,
  openKyara: (): Promise<boolean> => ipcRenderer.invoke('kyara:open-site'),
  getAutoStart: (): Promise<boolean> => ipcRenderer.invoke('kyara:get-autostart'),
  setAutoStart: (on: boolean): Promise<boolean> => ipcRenderer.invoke('kyara:set-autostart', on),
  openDataFolder: (): Promise<boolean> => ipcRenderer.invoke('kyara:open-data-folder'),
});
