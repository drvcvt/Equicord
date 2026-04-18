/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { onceDefined } from "@shared/onceDefined";
import electron, { app, BrowserWindowConstructorOptions, Menu } from "electron";
import net from "net";
import { dirname, join } from "path";

import { RendererSettings } from "./settings";
import { patchTrayMenu } from "./trayMenu";
import { IS_VANILLA } from "./utils/constants";

console.log("[Equicord] Starting up...");

const RPC_WSS_PORT_START = 6463;
const RPC_WSS_PORT_END = 6472;

function isDiscordRpcWebSocketModule(request: string, parentFilename?: string) {
    return request === "./RPCWebSocket" && !!parentFilename && /[\\/]discord_rpc[\\/]index\.js$/.test(parentFilename);
}

function isDiscordRpcModule(request: string, parentFilename?: string, loaded?: any) {
    const ref = `${parentFilename ?? ""}\n${request}`.replaceAll("\\", "/");

    return ref.includes("/discord_rpc/")
        || ref.endsWith("/discord_rpc")
        || (loaded?.RPCWebSocket?.http?.createServer != null && loaded?.RPCIPC != null);
}

function getRequestedPort(args: unknown[]) {
    return typeof args[0] === "number" ? args[0] : null;
}

function getRequestedHost(args: unknown[]) {
    return typeof args[1] === "string" ? args[1] : undefined;
}

async function canListenOnPort(port: number, host?: string) {
    const probe = net.createServer();

    return await new Promise<boolean>(resolve => {
        const cleanup = () => probe.removeAllListeners();

        probe.once("error", () => {
            cleanup();
            resolve(false);
        });

        probe.once("listening", () => {
            cleanup();
            probe.close(() => resolve(true));
        });

        probe.listen(port, host);
    });
}

async function findAvailableDiscordRpcPort(startPort: number, host?: string) {
    for (let port = startPort; port <= RPC_WSS_PORT_END; port++) {
        if (await canListenOnPort(port, host)) {
            return port;
        }
    }

    return startPort;
}

function patchDiscordRpcWebSocketListen(mod: any) {
    if (mod?.http?.createServer == null || mod.__equicordRpcWssPatched) {
        return mod;
    }

    const originalCreateServer = mod.http.createServer;

    mod.http.createServer = function (...createServerArgs: any[]) {
        const server = originalCreateServer.apply(this, createServerArgs);
        const originalListen = server?.listen;

        if (typeof originalListen !== "function" || server.__equicordRpcWssListenPatched) {
            return server;
        }

        Object.defineProperty(server, "__equicordRpcWssListenPatched", {
            configurable: true,
            enumerable: false,
            value: true,
        });

        server.listen = function (...listenArgs: any[]) {
            const requestedPort = getRequestedPort(listenArgs);

            if (requestedPort == null || requestedPort < RPC_WSS_PORT_START || requestedPort > RPC_WSS_PORT_END) {
                return originalListen.apply(this, listenArgs);
            }

            const host = getRequestedHost(listenArgs);

            void findAvailableDiscordRpcPort(requestedPort, host)
                .then(port => {
                    if (port !== requestedPort) {
                        console.warn(`[Equicord] discord_rpc websocket port ${requestedPort} is busy, using ${port} instead.`);
                    }

                    originalListen.apply(this, [port, ...listenArgs.slice(1)]);
                })
                .catch(error => {
                    console.warn("[Equicord] Failed to probe discord_rpc websocket ports, falling back to Discord default listen.", error);
                    originalListen.apply(this, listenArgs);
                });

            return this;
        };

        return server;
    };

    Object.defineProperty(mod, "__equicordRpcWssPatched", {
        configurable: true,
        enumerable: false,
        value: true,
    });

    return mod;
}

function patchDiscordRpcModule(mod: any) {
    if (mod?.RPCWebSocket?.http?.createServer != null) {
        patchDiscordRpcWebSocketListen(mod.RPCWebSocket);
    } else {
        patchDiscordRpcWebSocketListen(mod);
    }

    return mod;
}

const Module = require("module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
};
const originalModuleLoad = Module._load;
Module._load = function (request: string, parent: NodeModule | undefined, isMain: boolean) {
    const loaded = originalModuleLoad.apply(this, arguments as any);

    if (typeof request === "string" && isDiscordRpcModule(request, parent?.filename, loaded)) {
        const patched = patchDiscordRpcModule(loaded);

        if (isDiscordRpcWebSocketModule(request, parent?.filename) || loaded?.RPCWebSocket != null) {
            console.log("[Equicord] Patched Discord RPC websocket transport to avoid localhost port conflicts.");
        }

        return patched;
    }

    return loaded;
};

// Our injector file at app/index.js
const injectorPath = require.main!.filename;

// The original app.asar
const asarPath = join(dirname(injectorPath), "..", "_app.asar");

const discordPkg = require(join(asarPath, "package.json"));
require.main!.filename = join(asarPath, discordPkg.main);
if (IS_VESKTOP || IS_EQUIBOP) require.main!.filename = join(dirname(injectorPath), "..", "..", "package.json");

// @ts-expect-error Untyped method? Dies from cringe
app.setAppPath(asarPath);

if (!IS_VANILLA) {
    const settings = RendererSettings.store;

    patchTrayMenu();

    // Repatch after host updates on Windows
    if (process.platform === "win32") {
        require("./patchWin32Updater");

        if (settings.winCtrlQ) {
            const originalBuild = Menu.buildFromTemplate;
            Menu.buildFromTemplate = function (template) {
                if (template[0]?.label === "&File") {
                    const { submenu } = template[0];
                    if (Array.isArray(submenu)) {
                        submenu.push({
                            label: "Quit (Hidden)",
                            visible: false,
                            acceleratorWorksWhenHidden: true,
                            accelerator: "Control+Q",
                            click: () => app.quit()
                        });
                    }
                }
                return originalBuild.call(this, template);
            };
        }
    }

    class BrowserWindow extends electron.BrowserWindow {
        constructor(options: BrowserWindowConstructorOptions) {
            if (options?.webPreferences?.preload && options.title) {
                const original = options.webPreferences.preload;
                const isMainWindow = options.title === "Discord";
                options.webPreferences.preload = join(__dirname, "preload.js");
                options.webPreferences.sandbox = false;
                // work around discord unloading when in background
                options.webPreferences.backgroundThrottling = false;

                if (settings.frameless) {
                    options.frame = false;
                } else if (settings.mainWindowFrameless && isMainWindow) {
                    options.frame = false;
                } else if (process.platform === "win32" && settings.winNativeTitleBar) {
                    delete options.frame;
                }

                if (settings.transparent) {
                    options.transparent = true;
                    options.backgroundColor = "#00000000";
                }

                if (settings.disableMinSize) {
                    options.minWidth = 0;
                    options.minHeight = 0;
                }

                const needsVibrancy = process.platform === "darwin" && settings.macosVibrancyStyle;

                if (needsVibrancy) {
                    options.backgroundColor = "#00000000";
                    if (settings.macosVibrancyStyle) {
                        options.vibrancy = settings.macosVibrancyStyle;
                    }
                }

                process.env.DISCORD_PRELOAD = original;

                super(options);

                if (settings.disableMinSize) {
                    // Disable the Electron call entirely so that Discord can't dynamically change the size
                    this.setMinimumSize = (width: number, height: number) => { };
                }
            } else super(options);
        }
    }
    Object.assign(BrowserWindow, electron.BrowserWindow);
    // esbuild may rename our BrowserWindow, which leads to it being excluded
    // from getFocusedWindow(), so this is necessary
    // https://github.com/discord/electron/blob/13-x-y/lib/browser/api/browser-window.ts#L60-L62
    Object.defineProperty(BrowserWindow, "name", { value: "BrowserWindow", configurable: true });

    // Replace electrons exports with our custom BrowserWindow
    const electronPath = require.resolve("electron");
    delete require.cache[electronPath]!.exports;
    require.cache[electronPath]!.exports = {
        ...electron,
        BrowserWindow
    };

    // Patch appSettings to force enable devtools
    onceDefined(global, "appSettings", s => {
        s.set("DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING", true);
    });

    process.env.DATA_DIR = join(app.getPath("userData"), "..", "Equicord");

    // Monkey patch commandLine to:
    // - disable WidgetLayering: Fix DevTools context menus https://github.com/electron/electron/issues/38790
    // - disable UseEcoQoSForBackgroundProcess: Work around Discord unloading when in background
    const originalAppend = app.commandLine.appendSwitch;
    app.commandLine.appendSwitch = function (...args) {
        if (args[0] === "disable-features") {
            const disabledFeatures = new Set((args[1] ?? "").split(","));
            disabledFeatures.add("WidgetLayering");
            disabledFeatures.add("UseEcoQoSForBackgroundProcess");
            args[1] += [...disabledFeatures].join(",");
        }
        return originalAppend.apply(this, args);
    };

    // disable renderer backgrounding to prevent the app from unloading when in the background
    // https://github.com/electron/electron/issues/2822
    // https://github.com/GoogleChrome/chrome-launcher/blob/5a27dd574d47a75fec0fb50f7b774ebf8a9791ba/docs/chrome-flags-for-tools.md#task-throttling
    // Work around discord unloading when in background
    // Discord also recently started adding these flags but only on windows for some reason dunno why, it happens on Linux too
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
} else {
    console.log("[Equicord] Running in vanilla mode. Not loading Equicord");
}

console.log("[Equicord] Loading original Discord app.asar");
require(require.main!.filename);
