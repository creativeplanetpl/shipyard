import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { claudeRecordBody, readClaude, type JsonResponse } from "../shared/claude";
import {
  composeSnapshot, highestUsage, PROVIDER_META, tooltipText, trayIconBitmap,
  type PanelSnapshot, type ProviderId,
} from "../shared/usage";
import { getServiceSnapshot, publishClaude } from "./service";

const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_PARTITION = "persist:claude";
const REFRESH_MS = 5 * 60 * 1000;
const PANEL = { width: 320, height: 330 };

// --status prints one snapshot as JSON and quits; --capture=<file.png> also saves a picture of the panel.
// Both are for checking an install and only work while the tray app is not running.
const statusMode = process.argv.includes("--status");
const captureFile = process.argv.find((arg) => arg.startsWith("--capture="))?.slice("--capture=".length) ?? null;
// --probe prints what claude.ai answers to this embedded browser (status code, landing path, challenge page or not).
const probeMode = process.argv.includes("--probe");
const oneShot = statusMode || probeMode || captureFile !== null;

// The Claude session (cookies) lives here and nowhere else.
app.setPath("userData", path.join(process.env.LOCALAPPDATA ?? app.getPath("appData"), "cp-AImonitor", "tray-data"));

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let signInWindow: BrowserWindow | null = null;
let latest: PanelSnapshot | null = null;
let refreshing: Promise<PanelSnapshot> | null = null;
let quitting = false;
// The panel reports how tall its content is, so all cards show without scrolling when the screen allows.
let panelHeight = PANEL.height;

function claudeSession() {
  return session.fromPartition(CLAUDE_PARTITION);
}

async function claudeFetch(apiPath: string): Promise<JsonResponse> {
  const response = await claudeSession().fetch(`${CLAUDE_ORIGIN}${apiPath}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* challenge page or empty body */ }
  return { status: response.status, body };
}

function refresh(): Promise<PanelSnapshot> {
  refreshing ??= (async () => {
    try {
      const claude = await readClaude(claudeFetch);
      const record = claudeRecordBody(claude);
      if (record) await publishClaude(record);
      latest = composeSnapshot(await getServiceSnapshot(), claude);
      updateTray();
      panel?.webContents.send("monitor:update", latest);
      return latest;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function trayImage(used: number | null) {
  return nativeImage.createFromBitmap(Buffer.from(trayIconBitmap(used)), { width: 32, height: 32, scaleFactor: 2 });
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayImage(highestUsage(latest)?.used ?? null));
  tray.setToolTip(tooltipText(latest));
}

function placePanel() {
  if (!panel || !tray) return;
  const bounds = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const height = Math.min(panelHeight, area.height - 16);
  panel.setSize(PANEL.width, height, false);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  const x = clamp(Math.round(bounds.x + bounds.width / 2 - PANEL.width / 2), area.x + 8, area.x + area.width - PANEL.width - 8);
  // Taskbar at the top puts the icon above the work area; everywhere else the panel sits at the bottom edge.
  const y = bounds.y < area.y ? area.y + 8 : area.y + area.height - height - 8;
  panel.setPosition(x, y, false);
}

function createPanel() {
  panel = new BrowserWindow({
    ...PANEL,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#14171f",
    title: "AI Monitor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  // The panel never navigates anywhere and never opens windows of its own.
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    panel?.hide();
  });
}

function showPanel() {
  if (!panel) return;
  placePanel();
  panel.show();
  panel.focus();
  refresh().catch(() => {});
}

function togglePanel() {
  if (panel?.isVisible()) panel.hide();
  else showPanel();
}

function openSignIn() {
  if (signInWindow) { signInWindow.focus(); return; }
  signInWindow = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Sign in to Claude - AI Monitor",
    autoHideMenuBar: true,
    webPreferences: { partition: CLAUDE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const window = signInWindow;
  let checking = false;
  const check = async () => {
    if (checking || window.isDestroyed()) return;
    checking = true;
    try {
      const snapshot = await refresh();
      const signedIn = snapshot.providers.find((provider) => provider.id === "claude")?.state === "ready";
      if (signedIn && !window.isDestroyed()) window.close();
    } catch { /* keep the window open */ } finally {
      checking = false;
    }
  };
  // Only https pages, in this same session; nothing else may be opened from the sign-in page.
  window.webContents.setWindowOpenHandler(({ url }) => ({ action: url.startsWith("https://") ? "allow" : "deny" }));
  window.webContents.on("did-navigate", check);
  window.webContents.on("did-navigate-in-page", check);
  window.on("closed", () => {
    signInWindow = null;
    refresh().catch(() => {});
  });
  window.loadURL(`${CLAUDE_ORIGIN}/login`);
}

async function signOut() {
  signInWindow?.close();
  await claudeSession().clearStorageData();
  await refresh().catch(() => {});
}

function createTray() {
  tray = new Tray(trayImage(null));
  tray.setToolTip("AI Monitor");
  tray.on("click", togglePanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open AI Monitor", click: showPanel },
    { label: "Refresh", click: () => { refresh().catch(() => {}); } },
    { type: "separator" },
    { label: "Sign in to Claude", click: openSignIn },
    { label: "Sign out of Claude", click: () => { signOut().catch(() => {}); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

function registerIpc() {
  ipcMain.handle("monitor:get", () => latest);
  ipcMain.handle("monitor:refresh", () => refresh());
  ipcMain.handle("monitor:sign-in", () => { openSignIn(); });
  ipcMain.handle("monitor:hide", () => { panel?.hide(); });
  ipcMain.handle("monitor:resize", (_event, height: unknown) => {
    if (typeof height !== "number" || !Number.isFinite(height) || !panel) return;
    panelHeight = Math.max(200, Math.min(1400, Math.ceil(height)));
    if (tray) placePanel();
    else panel.setSize(PANEL.width, panelHeight, false);
  });
  ipcMain.handle("monitor:open-provider", (_event, id: ProviderId) => {
    // Fixed addresses only; the panel cannot make the app open an arbitrary link.
    const meta = Object.prototype.hasOwnProperty.call(PROVIDER_META, id) ? PROVIDER_META[id] : null;
    if (meta) shell.openExternal(meta.url);
  });
}

async function probe() {
  const answer = await claudeFetch("/api/organizations").catch(() => ({ status: 0, body: null }));
  const organizations = answer.status;
  // A JSON error means Claude's own API answered; a null body means something in front of it did.
  const errorType = (answer.body as { error?: { type?: unknown } } | null)?.error?.type;
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition: CLAUDE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let loaded = true;
  await window.loadURL(`${CLAUDE_ORIGIN}/login`).catch(() => { loaded = false; });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const title = window.webContents.getTitle();
  const landing = new URL(window.webContents.getURL());
  const hasForm = await window.webContents
    .executeJavaScript("Boolean(document.querySelector('input[type=email], input[name=email], button'))")
    .catch(() => false);
  window.destroy();
  return {
    organizationsStatus: organizations,
    apiAnsweredJson: answer.body !== null,
    apiErrorType: typeof errorType === "string" ? errorType.slice(0, 40) : null,
    loginLoaded: loaded,
    landingHost: landing.host,
    landingPath: landing.pathname,
    challengePage: /just a moment|attention required|verify you are human/i.test(title),
    loginControlsFound: Boolean(hasForm),
  };
}

async function runOneShot() {
  if (probeMode) {
    fs.writeSync(1, `${JSON.stringify(await probe())}
`);
    quitting = true;
    app.quit();
    return;
  }
  const snapshot = await refresh();
  if (captureFile && panel) {
    panel.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(captureFile, (await panel.webContents.capturePage()).toPNG());
  }
  if (statusMode) fs.writeSync(1, `${JSON.stringify(snapshot)}\n`);
  quitting = true;
  app.quit();
}

if (!oneShot && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showPanel);
  app.on("window-all-closed", () => { /* stay in the tray */ });
  app.on("before-quit", () => { quitting = true; });
  app.whenReady().then(() => {
    registerIpc();
    createPanel();
    if (oneShot) {
      runOneShot().catch(() => { app.exit(1); });
      return;
    }
    createTray();
    refresh().catch(() => {});
    setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  });
}
