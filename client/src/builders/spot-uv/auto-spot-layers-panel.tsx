import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, RefreshCw, Sparkles, X } from "lucide-react";
import type { ExtractedColor } from "./lib/color-extractor";
import { generateAutoSpotSelections, type AutoSpotSettings } from "./lib/auto-spot-layers";

interface AutoSpotLayersPanelProps {
  image: CanvasImageSource | null | undefined;
  colors: ExtractedColor[];
  pixelMap?: Int16Array;
  mapWidth?: number;
  mapHeight?: number;
  onApply: (colors: ExtractedColor[], source: { image: CanvasImageSource | null | undefined; colors: ExtractedColor[]; pixelMap?: Int16Array; mapWidth?: number; mapHeight?: number }) => boolean;
  onApplied?: () => void;
}

const defaults: AutoSpotSettings = {
  white: "solid",
  gloss: "relief",
  whiteThreshold: 0.68,
  glossThreshold: 0.57,
  invertGloss: false,
  regionCoverage: 0.42,
};

function maskUrl(mask: Uint8ClampedArray, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas mask preview is unavailable.");
  const data = context.createImageData(width, height);
  for (let i = 0; i < mask.length; i += 1) {
    const value = mask[i];
    const offset = i * 4;
    data.data[offset] = value;
    data.data[offset + 1] = value;
    data.data[offset + 2] = value;
    data.data[offset + 3] = 255;
  }
  context.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

export default function AutoSpotLayersPanel({
  image,
  colors,
  pixelMap,
  mapWidth,
  mapHeight,
  onApply,
  onApplied,
}: AutoSpotLayersPanelProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AutoSpotSettings>(defaults);
  const [preview, setPreview] = useState<{ source: object; sourceColors: ExtractedColor[]; settingsVersion: number; colors: ExtractedColor[]; white: string; gloss: string; whitePixels: number; glossPixels: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "generating" | "error" | "applied">("idle");
  const [message, setMessage] = useState("");
  const source = useMemo(() => ({ image, colors, pixelMap, mapWidth, mapHeight }), [image, colors, pixelMap, mapWidth, mapHeight]);
  const sourceRef = useRef(source);
  const settingsVersionRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const appliedColorsRef = useRef<ExtractedColor[] | null>(null);
  sourceRef.current = source;

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPreview(null);
    if (!(status === "applied" && appliedColorsRef.current === source.colors)) {
      appliedColorsRef.current = null;
      setStatus("idle");
      setMessage("");
    }
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [source]);

  const update = <K extends keyof AutoSpotSettings>(key: K, value: AutoSpotSettings[K]) => {
    settingsVersionRef.current += 1;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setSettings((current: AutoSpotSettings) => ({ ...current, [key]: value }));
    setPreview(null);
    setStatus("idle");
    setMessage("");
  };

  const generate = () => {
    setPreview(null);
    if (!image || !pixelMap || !mapWidth || !mapHeight || colors.length === 0) {
      setStatus("error");
      setMessage("Wait for the image and its color map before generating selections.");
      return;
    }
    if (mapWidth * mapHeight > 1_000_000) {
      setStatus("error");
      setMessage("This selection map is too large to safely preview.");
      return;
    }
    if (pixelMap.length !== mapWidth * mapHeight) {
      setStatus("error");
      setMessage("The color map does not match its selection geometry.");
      return;
    }
    const sourceWithSize = image as CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
    const sourceWidth = sourceWithSize.naturalWidth || sourceWithSize.width || 0;
    const sourceHeight = sourceWithSize.naturalHeight || sourceWithSize.height || 0;
    if (sourceWidth && sourceHeight && Math.abs((sourceWidth / sourceHeight) / (mapWidth / mapHeight) - 1) > 0.02) {
      setStatus("error");
      setMessage("The color map belongs to a different image geometry. Wait for extraction to refresh.");
      return;
    }
    const currentSource = source;
    const currentSettingsVersion = settingsVersionRef.current;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    setStatus("generating");
    setMessage("");
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      try {
        if (sourceRef.current !== currentSource || settingsVersionRef.current !== currentSettingsVersion) return;
        const canvas = document.createElement("canvas");
        canvas.width = mapWidth;
        canvas.height = mapHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas selection preview is unavailable.");
        context.drawImage(image, 0, 0, mapWidth, mapHeight);
        const imageData = context.getImageData(0, 0, mapWidth, mapHeight);
        const result = generateAutoSpotSelections({
          imageData,
          colors,
          pixelMap,
          settings,
        });
        if (sourceRef.current !== currentSource || settingsVersionRef.current !== currentSettingsVersion || result.width !== mapWidth || result.height !== mapHeight) return;
        setPreview({
          source: currentSource,
          sourceColors: currentSource.colors,
          settingsVersion: currentSettingsVersion,
          colors: result.colors,
          white: maskUrl(result.whiteMask, result.width, result.height),
          gloss: maskUrl(result.glossMask, result.width, result.height),
          whitePixels: result.whitePixels,
          glossPixels: result.glossPixels,
        });
        setStatus("idle");
      } catch (error) {
        if (sourceRef.current !== currentSource || settingsVersionRef.current !== currentSettingsVersion) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Could not generate spot selections.");
      }
    });
  };

  const unavailable = !image || !pixelMap || !mapWidth || !mapHeight || colors.length === 0;
  const selectClass = "min-w-0 rounded-md border border-[#78a0c7]/45 bg-[#244e7a] px-2 py-1.5 text-xs text-[#edf6ff] outline-none focus:border-[#4dff80]";

  return (
    <div className="border-b border-white/10">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-white/5">
        <span className="flex items-center gap-2 text-sm font-medium text-[#e8eef6]"><Sparkles className="h-4 w-4 text-[#4dff80]" />Auto Spot Layers</span>
        {open ? <ChevronUp className="h-4 w-4 text-[#9fb3c8]" /> : <ChevronDown className="h-4 w-4 text-[#9fb3c8]" />}
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 text-[#dcecff]">
          <p className="text-[11px] leading-relaxed text-[#b8cce0]">Build solid selections from the existing color map. Relief follows a brightness guide for engraving-style gloss; it is not true 3D depth.</p>
          <div className="grid grid-cols-[1fr_auto] items-center gap-2">
            <label htmlFor="auto-spot-white-preset" className="text-xs font-semibold">White underbase</label>
            <select id="auto-spot-white-preset" value={settings.white} onChange={event => update("white", event.target.value as AutoSpotSettings["white"])} className={selectClass}>
              <option value="solid">Solid</option><option value="light">Light tones</option><option value="dark">Dark tones</option><option value="keep">Keep current</option><option value="clear">Clear</option>
            </select>
            <label htmlFor="auto-spot-gloss-preset" className="text-xs font-semibold">Gloss finish</label>
            <select id="auto-spot-gloss-preset" value={settings.gloss} onChange={event => update("gloss", event.target.value as AutoSpotSettings["gloss"])} className={selectClass}>
              <option value="relief">Relief</option><option value="detail">Details</option><option value="highlights">Highlights</option><option value="keep">Keep current</option><option value="clear">Clear</option>
            </select>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-[#b8cce0]">White threshold <b className="float-right text-[#4dff80]">{Math.round(settings.whiteThreshold * 100)}%</b><input aria-label="White threshold" type="range" min="0" max="1" step="0.01" value={settings.whiteThreshold} onChange={event => update("whiteThreshold", Number(event.target.value))} className="mt-1 w-full accent-[#4dff80]" /></label>
            <label className="text-[11px] text-[#b8cce0]">Gloss threshold <b className="float-right text-[#4dff80]">{Math.round(settings.glossThreshold * 100)}%</b><input aria-label="Gloss threshold" type="range" min="0" max="1" step="0.01" value={settings.glossThreshold} onChange={event => update("glossThreshold", Number(event.target.value))} className="mt-1 w-full accent-[#4dff80]" /></label>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={settings.invertGloss} onChange={event => update("invertGloss", event.target.checked)} className="accent-[#4dff80]" />Invert gloss</label>
            <label className="min-w-[130px] flex-1 text-[#b8cce0]">Region coverage <b className="float-right text-[#4dff80]">{Math.round(settings.regionCoverage * 100)}%</b><input aria-label="Region coverage" type="range" min="0" max="1" step="0.01" value={settings.regionCoverage} onChange={event => update("regionCoverage", Number(event.target.value))} className="mt-1 w-full accent-[#4dff80]" /></label>
          </div>
          {unavailable && <div role="status" className="rounded-md border border-[#4dff80]/20 bg-[#05321a] px-2.5 py-2 text-[11px] text-[#b6f8ca]">Color extraction is still preparing the map.</div>}
          {status === "error" && <div role="alert" className="flex gap-2 rounded-md border border-rose-300/30 bg-rose-950/20 px-2.5 py-2 text-[11px] text-rose-100"><AlertCircle className="h-4 w-4 shrink-0" />{message}</div>}
          {status === "applied" && <div role="status" className="rounded-md border border-[#4dff80]/25 bg-[#05321a] px-2.5 py-2 text-[11px] text-[#b6f8ca]">{message}</div>}
          <button type="button" onClick={generate} disabled={unavailable || status === "generating"} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4dff80] px-3 py-2 text-xs font-bold text-[#05321a] transition hover:bg-[#74ff9c] disabled:cursor-not-allowed disabled:opacity-45">
            <RefreshCw className={`h-3.5 w-3.5 ${status === "generating" ? "animate-spin" : ""}`} />{status === "generating" ? "Generating…" : "Generate preview"}
          </button>
          {preview && <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {[["White", preview.white, preview.whitePixels], ["Gloss", preview.gloss, preview.glossPixels]].map(([name, src, count]) => <div key={String(name)} className="overflow-hidden rounded-md border border-[#78a0c7]/35 bg-[#244e7a]"><img src={String(src)} alt={`${name} solid spot selection`} className="aspect-square w-full bg-[#dcecff] object-contain" /><div className="flex justify-between px-2 py-1 text-[10px]"><b>{name}</b><span>{Number(count).toLocaleString()} px</span></div></div>)}
            </div>
            <p className="text-[10px] leading-snug text-[#b8cce0]">Apply changes only existing color and region selection flags. Use the color list or canvas tools for manual cleanup.</p>
            <div className="flex gap-2"><button type="button" onClick={() => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); rafRef.current = null; appliedColorsRef.current = null; setPreview(null); setStatus("idle"); setMessage(""); }} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-white/15 py-2 text-xs hover:bg-white/10"><X className="h-3.5 w-3.5" />Clear</button><button type="button" onClick={() => { if (sourceRef.current === preview.source && settingsVersionRef.current === preview.settingsVersion && onApply(preview.colors, preview.source as { image: CanvasImageSource | null | undefined; colors: ExtractedColor[]; pixelMap?: Int16Array; mapWidth?: number; mapHeight?: number })) { appliedColorsRef.current = preview.colors; onApplied?.(); setStatus("applied"); setMessage("Selections applied. Refine with Spot White and Gloss tools."); } else { setStatus("error"); setMessage("Preview is stale. Generate it again for this image."); } setPreview(null); }} className="flex flex-[1.4] items-center justify-center gap-1 rounded-md bg-[#4dff80] py-2 text-xs font-bold text-[#05321a]"><Check className="h-3.5 w-3.5" />Apply selections</button></div>
          </div>}
        </div>
      )}
    </div>
  );
}