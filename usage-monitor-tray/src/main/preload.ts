import { contextBridge, ipcRenderer } from "electron";
import type { PanelSnapshot, ProviderId } from "../shared/usage";

const api = {
  get: (): Promise<PanelSnapshot | null> => ipcRenderer.invoke("monitor:get"),
  refresh: (): Promise<PanelSnapshot> => ipcRenderer.invoke("monitor:refresh"),
  signIn: (): Promise<void> => ipcRenderer.invoke("monitor:sign-in"),
  openProvider: (id: ProviderId): Promise<void> => ipcRenderer.invoke("monitor:open-provider", id),
  hide: (): Promise<void> => ipcRenderer.invoke("monitor:hide"),
  resize: (height: number): Promise<void> => ipcRenderer.invoke("monitor:resize", height),
  onUpdate: (listener: (snapshot: PanelSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, snapshot: PanelSnapshot) => listener(snapshot);
    ipcRenderer.on("monitor:update", handler);
    return () => { ipcRenderer.removeListener("monitor:update", handler); };
  },
};

export type MonitorApi = typeof api;

contextBridge.exposeInMainWorld("monitor", api);
