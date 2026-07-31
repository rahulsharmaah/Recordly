import { useEffect, useState } from "react";
import { toast } from "sonner";

export function AiAudioSettings() {
	const [provider, setProvider] = useState("openai");
	const [endpoint, setEndpoint] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [hasApiKey, setHasApiKey] = useState(false);
	useEffect(() => { void window.electronAPI.getAiAudioSettings().then((settings) => { setProvider(settings.provider); setEndpoint(settings.endpoint); setHasApiKey(settings.hasApiKey); }); }, []);
	const save = async () => {
		const result = await window.electronAPI.saveAiAudioSettings({ provider, endpoint, apiKey });
		if (!result.success) { toast.error(result.error ?? "Could not save AI audio settings"); return; }
		setApiKey(""); setHasApiKey(Boolean(result.hasApiKey)); toast.success("AI audio settings saved securely");
	};
	return <section className="flex flex-col gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3"><div><div className="text-sm font-semibold">AI Audio</div><p className="mt-0.5 text-xs text-muted-foreground">Create narration from transcripts or translate and dub existing audio. Your key stays encrypted on this device.</p></div><select value={provider} onChange={(event) => setProvider(event.target.value)} className="h-9 rounded-lg border border-foreground/10 bg-background px-2 text-sm"><option value="openai">OpenAI</option><option value="elevenlabs">ElevenLabs</option><option value="custom">Custom provider</option></select>{provider === "custom" && <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://your-provider.example/v1" className="h-9 rounded-lg border border-foreground/10 bg-background px-2 text-sm" />}<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={hasApiKey ? "API key saved — enter a new key to replace" : "Paste API key"} className="h-9 rounded-lg border border-foreground/10 bg-background px-2 text-sm"/><button type="button" onClick={() => void save()} className="h-9 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white hover:bg-blue-500">Save provider</button></section>;
}
