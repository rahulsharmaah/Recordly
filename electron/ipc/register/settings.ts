import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { app, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { hideCursor } from "../../cursorHider";
import { closeCountdownWindow, createCountdownWindow, getCountdownWindow } from "../../windows";
import {
	APP_SETTINGS_FILE,
	COUNTDOWN_SETTINGS_FILE,
	RECORDINGS_SETTINGS_FILE,
	SHORTCUTS_FILE,
} from "../constants";
import {
	countdownCancelled,
	countdownInProgress,
	countdownRemaining,
	countdownTimer,
	setCountdownCancelled,
	setCountdownInProgress,
	setCountdownRemaining,
	setCountdownTimer,
} from "../state";
import { parseJsonWithByteOrderMark } from "../utils";

const BROWSER_MICROPHONE_PROFILE_ENV = "RECORDLY_BROWSER_MIC_PROFILE";
const DEFAULT_BROWSER_MICROPHONE_PROFILE = "processed";
const BROWSER_MICROPHONE_PROFILES = new Set([
	"processed",
	"no-agc",
	"no-echo",
	"no-noise-suppression",
	"raw",
]);
const AI_AUDIO_SETTINGS_FILE = path.join(app.getPath("userData"), "ai-audio-settings.json");

function getBrowserMicrophoneProfileFromEnv() {
	const requested = process.env[BROWSER_MICROPHONE_PROFILE_ENV]?.trim() || null;
	const normalized = requested?.toLowerCase() ?? DEFAULT_BROWSER_MICROPHONE_PROFILE;
	return {
		browserMicrophoneProfile: BROWSER_MICROPHONE_PROFILES.has(normalized)
			? normalized
			: DEFAULT_BROWSER_MICROPHONE_PROFILE,
		requestedBrowserMicrophoneProfile: requested,
	};
}

function readAppSettingsStore(): Record<string, unknown> {
	try {
		const content = readFileSync(APP_SETTINGS_FILE, "utf-8");
		const parsed = parseJsonWithByteOrderMark<unknown>(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}

		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeAppSettingsStore(store: Record<string, unknown>) {
	writeFileSync(APP_SETTINGS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function hasAppSetting(store: Record<string, unknown>, key: string): boolean {
	return Reflect.getOwnPropertyDescriptor(store, key) !== undefined;
}

export function registerSettingsHandlers() {
	ipcMain.handle("ai-audio-settings:get", async () => {
		try {
			const saved = JSON.parse(await fs.readFile(AI_AUDIO_SETTINGS_FILE, "utf8")) as Record<string, unknown>;
			return { success: true, provider: typeof saved.provider === "string" ? saved.provider : "openai", endpoint: typeof saved.endpoint === "string" ? saved.endpoint : "", hasApiKey: typeof saved.apiKey === "string" && saved.apiKey.length > 0 };
		} catch {
			return { success: true, provider: "openai", endpoint: "", hasApiKey: false };
		}
	});
	ipcMain.handle("ai-audio-settings:save", async (_event, input: unknown) => {
		if (!input || typeof input !== "object") return { success: false, error: "Invalid AI audio settings" };
		const value = input as { provider?: unknown; endpoint?: unknown; apiKey?: unknown };
		const provider = typeof value.provider === "string" && ["openai", "elevenlabs", "custom"].includes(value.provider) ? value.provider : "openai";
		const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
		const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
		try {
			const encryptedKey = apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(apiKey).toString("base64") : "";
			await fs.writeFile(AI_AUDIO_SETTINGS_FILE, JSON.stringify({ provider, endpoint, apiKey: encryptedKey }, null, 2), "utf8");
			return { success: true, hasApiKey: Boolean(encryptedKey) };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : "Failed to save AI audio settings" };
		}
	});
	ipcMain.handle("app:getVersion", () => {
		return app.getVersion();
	});

	ipcMain.handle("get-platform", () => {
		return process.platform;
	});

	ipcMain.on("app-settings:get", (event, key: unknown) => {
		try {
			if (typeof key !== "string" || key.length === 0) {
				event.returnValue = { success: false, value: null };
				return;
			}

			const store = readAppSettingsStore();
			event.returnValue = {
				success: true,
				value: hasAppSetting(store, key) ? store[key] : null,
			};
		} catch (error) {
			console.error("Failed to read app setting:", error);
			event.returnValue = { success: false, value: null };
		}
	});

	ipcMain.on("app-settings:set", (event, key: unknown, value: unknown) => {
		try {
			if (typeof key !== "string" || key.length === 0) {
				event.returnValue = { success: false };
				return;
			}

			const store = readAppSettingsStore();
			store[key] = value;
			writeAppSettingsStore(store);
			event.returnValue = { success: true };
		} catch (error) {
			console.error("Failed to save app setting:", error);
			event.returnValue = { success: false };
		}
	});

	// ---------------------------------------------------------------------------
	// Cursor hiding for the browser-capture fallback.
	// The IPC promise resolves only after the cursor hide attempt completes.
	// ---------------------------------------------------------------------------
	ipcMain.handle("hide-cursor", () => {
		if (process.platform !== "win32") {
			return { success: true };
		}

		return { success: hideCursor() };
	});

	ipcMain.handle("get-shortcuts", async () => {
		try {
			const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
			return parseJsonWithByteOrderMark(data);
		} catch {
			return null;
		}
	});

	ipcMain.handle("save-shortcuts", async (_, shortcuts: unknown) => {
		try {
			await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), "utf-8");
			return { success: true };
		} catch (error) {
			console.error("Failed to save shortcuts:", error);
			return { success: false, error: String(error) };
		}
	});

	// ---------------------------------------------------------------------------
	// Countdown timer before recording
	// ---------------------------------------------------------------------------
	ipcMain.handle("get-recording-preferences", async () => {
		try {
			const content = await fs.readFile(RECORDINGS_SETTINGS_FILE, "utf-8");
			const parsed = parseJsonWithByteOrderMark<Record<string, unknown>>(content);
			return {
				success: true,
				microphoneEnabled: parsed.microphoneEnabled === true,
				microphoneDeviceId:
					typeof parsed.microphoneDeviceId === "string"
						? parsed.microphoneDeviceId
						: undefined,
				systemAudioEnabled: parsed.systemAudioEnabled === true,
			};
		} catch {
			return {
				success: true,
				microphoneEnabled: false,
				microphoneDeviceId: undefined,
				systemAudioEnabled: false,
			};
		}
	});

	ipcMain.handle("get-recording-audio-lab-config", () => {
		return getBrowserMicrophoneProfileFromEnv();
	});

	ipcMain.handle(
		"set-recording-preferences",
		async (
			_,
			prefs: {
				microphoneEnabled?: boolean;
				microphoneDeviceId?: string;
				systemAudioEnabled?: boolean;
			},
		) => {
			try {
				let existing: Record<string, unknown> = {};
				try {
					const content = await fs.readFile(RECORDINGS_SETTINGS_FILE, "utf-8");
					existing = parseJsonWithByteOrderMark<Record<string, unknown>>(content);
				} catch {
					// file doesn't exist yet
				}
				const merged = { ...existing, ...prefs };
				await fs.writeFile(
					RECORDINGS_SETTINGS_FILE,
					JSON.stringify(merged, null, 2),
					"utf-8",
				);
				return { success: true };
			} catch (error) {
				console.error("Failed to save recording preferences:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("get-countdown-delay", async () => {
		try {
			const content = await fs.readFile(COUNTDOWN_SETTINGS_FILE, "utf-8");
			const parsed = parseJsonWithByteOrderMark<{ delay?: number }>(content);
			return { success: true, delay: parsed.delay ?? 3 };
		} catch {
			return { success: true, delay: 3 };
		}
	});

	ipcMain.handle("set-countdown-delay", async (_, delay: number) => {
		try {
			await fs.writeFile(
				COUNTDOWN_SETTINGS_FILE,
				JSON.stringify({ delay }, null, 2),
				"utf-8",
			);
			return { success: true };
		} catch (error) {
			console.error("Failed to save countdown delay:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("start-countdown", async (_, seconds: number) => {
		if (countdownInProgress) {
			return { success: false, error: "Countdown already in progress" };
		}

		setCountdownInProgress(true);
		setCountdownCancelled(false);
		setCountdownRemaining(seconds);

		const countdownWin = createCountdownWindow();

		if (countdownWin.webContents.isLoadingMainFrame()) {
			await new Promise<void>((resolve) => {
				countdownWin.webContents.once("did-finish-load", () => {
					resolve();
				});
			});
		}

		return new Promise<{ success: boolean; cancelled?: boolean }>((resolve) => {
			let remaining = seconds;
			setCountdownRemaining(remaining);

			countdownWin.webContents.send("countdown-tick", remaining);

			setCountdownTimer(
				setInterval(() => {
					if (countdownCancelled) {
						if (countdownTimer) {
							clearInterval(countdownTimer);
							setCountdownTimer(null);
						}
						closeCountdownWindow();
						setCountdownInProgress(false);
						setCountdownRemaining(null);
						resolve({ success: false, cancelled: true });
						return;
					}

					remaining--;
					setCountdownRemaining(remaining);

					if (remaining <= 0) {
						if (countdownTimer) {
							clearInterval(countdownTimer);
							setCountdownTimer(null);
						}
						closeCountdownWindow();
						setCountdownInProgress(false);
						setCountdownRemaining(null);
						resolve({ success: true });
					} else {
						const win = getCountdownWindow();
						if (win && !win.isDestroyed()) {
							win.webContents.send("countdown-tick", remaining);
						}
					}
				}, 1000),
			);
		});
	});

	ipcMain.handle("cancel-countdown", () => {
		setCountdownCancelled(true);
		setCountdownInProgress(false);
		setCountdownRemaining(null);
		if (countdownTimer) {
			clearInterval(countdownTimer);
			setCountdownTimer(null);
		}
		closeCountdownWindow();
		return { success: true };
	});

	ipcMain.handle("get-active-countdown", () => {
		return {
			success: true,
			seconds: countdownInProgress ? countdownRemaining : null,
		};
	});
}
