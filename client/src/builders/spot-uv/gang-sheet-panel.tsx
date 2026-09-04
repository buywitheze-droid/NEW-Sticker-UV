import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  packGangSheet,
  maxQuantityForItem,
  clampGangSheetQuantity,
  downloadGangSheetPDF,
  expandSettingsToFit,
  GANG_SHEET_PRESETS,
  type GangSheetItem,
  type GangSheetSettings,
  type PackResult,
} from "./lib/gang-sheet";
import { useToast } from "@/hooks/use-toast";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import { useSaveGangSheet } from "@/hooks/use-gang-sheets";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface GangSheetPanelProps {
  items: GangSheetItem[];
  onItemsChange: (items: GangSheetItem[]) => void;
  settings: GangSheetSettings;
  onSettingsChange: (settings: GangSheetSettings) => void;
  onFillSheet?: () => void;
  packResult?: PackResult;
}

export default function GangSheetPanel({
  items,
  onItemsChange,
  settings,
  onSettingsChange,
  onFillSheet,
  packResult: packResultProp,
}: GangSheetPanelProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveNameDialogOpen, setSaveNameDialogOpen] = useState(false);
  const [saveNameValue, setSaveNameValue] = useState("");
  const [fitWarning, setFitWarning] = useState<{ id: string; maxFit: number } | null>(null);
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();
  const saveGangSheetMutation = useSaveGangSheet();

  const packResult: PackResult = useMemo(
    () => packResultProp ?? packGangSheet(items, settings),
    [packResultProp, items, settings]
  );

  const totalStickers = items.reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0);
  const placedStickers = packResult.placements.length;

  const fitInfo = useMemo(() => {
    const usableW = settings.sheetWidth - settings.edgePadding * 2;
    const usableH = settings.sheetHeight - settings.edgePadding * 2;
    const tooBigIds = new Set<string>();
    if (usableW <= 0 || usableH <= 0) {
      for (const i of items) tooBigIds.add(i.id);
      return { tooBigIds, usableW, usableH };
    }
    for (const item of items) {
      const w = item.contourData.widthInches;
      const h = item.contourData.heightInches;
      if (!(w > 0) || !(h > 0)) continue;
      const fitsNormal = w <= usableW && h <= usableH;
      const fitsRotated = h <= usableW && w <= usableH;
      if (!fitsNormal && !fitsRotated) tooBigIds.add(item.id);
    }
    return { tooBigIds, usableW, usableH };
  }, [items, settings.sheetWidth, settings.sheetHeight, settings.edgePadding]);

  const tooBigCount = fitInfo.tooBigIds.size;

  const applyQuantity = useCallback(
    (id: string, desired: number) => {
      const current = items.find((i) => i.id === id);
      if (!current) return;
      if (!Number.isFinite(desired) || desired < 1) {
        onItemsChange(items.filter((i) => i.id !== id));
        setFitWarning(null);
        return;
      }
      const safeDesired = clampGangSheetQuantity(desired);
      const candidate = items.map((i) => (i.id === id ? { ...i, quantity: safeDesired } : i));
      if (packGangSheet(candidate, settings).overflow === 0) {
        onItemsChange(candidate);
        setFitWarning(null);
        return;
      }

      const grown = expandSettingsToFit(candidate, settings);
      if (grown.overflow === 0) {
        if (grown.expanded) {
          onSettingsChange(grown.settings);
          toast({
            title: "Gangsheet expanded",
            description: `Sheet size auto-expanded to ${grown.settings.sheetWidth}" × ${grown.settings.sheetHeight}" to fit your copies.`,
          });
        }
        onItemsChange(candidate);
        setFitWarning(null);
        return;
      }

      const maxFit = maxQuantityForItem(items, grown.settings, id);
      if (grown.expanded) {
        onSettingsChange(grown.settings);
        toast({
          title: "Gangsheet expanded to maximum",
          description: `Sheet expanded to ${grown.settings.sheetWidth}" × ${grown.settings.sheetHeight}". Only ${Math.max(1, maxFit)} copies fit.`,
        });
      }
      onItemsChange(items.map((i) => (i.id === id ? { ...i, quantity: Math.max(1, maxFit) } : i)));
      setFitWarning({ id, maxFit: Math.max(1, maxFit) });
      setTimeout(() => setFitWarning(null), 3000);
    },
    [items, onItemsChange, onSettingsChange, settings, toast]
  );

  const handleQuantityChange = useCallback(
    (id: string, delta: number) => {
      const current = items.find((i) => i.id === id);
      if (!current) return;
      applyQuantity(id, (Number(current.quantity) || 0) + delta);
    },
    [applyQuantity, items]
  );

  const handleQuantitySet = useCallback(
    (id: string, desired: number) => {
      applyQuantity(id, desired);
    },
    [applyQuantity]
  );

  const handleRemove = useCallback(
    (id: string) => {
      onItemsChange(items.filter((item) => item.id !== id));
    },
    [items, onItemsChange]
  );

  const handleClearAll = useCallback(() => {
    onItemsChange([]);
  }, [onItemsChange]);

  const handlePresetChange = useCallback(
    (value: string) => {
      const preset = GANG_SHEET_PRESETS.find((p) => p.label === value);
      if (preset) {
        onSettingsChange({
          ...settings,
          sheetWidth: preset.width,
          sheetHeight: preset.height,
        });
      }
    },
    [settings, onSettingsChange]
  );

  const handleFillSheet = useCallback(() => {
    if (onFillSheet) {
      onFillSheet();
      return;
    }
    if (items.length === 0) return;
    const target = items[items.length - 1];
    const maxFit = maxQuantityForItem(items, settings, target.id);
    if (maxFit <= clampGangSheetQuantity(target.quantity)) {
      toast({
        title: "Sheet is full",
        description: "No more copies of this design fit at the current sheet size.",
      });
      return;
    }
    onItemsChange(items.map((i) => (i.id === target.id ? { ...i, quantity: maxFit } : i)));
  }, [items, settings, onItemsChange, onFillSheet, toast]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      await downloadGangSheetPDF(items, settings, packResult.placements);
    } catch (err) {
      console.error("[GangSheet] PDF export failed:", err);
      toast({
        title: "Couldn't export gang sheet",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  }, [items, settings, packResult, toast]);

  const handleSaveGangSheet = useCallback(() => {
    if (!isAuthenticated) {
      toast({ title: "Sign in required", description: "Log in to save gang sheets.", variant: "destructive" });
      return;
    }
    setSaveNameValue(`Gang Sheet ${settings.sheetWidth}x${settings.sheetHeight}`);
    setSaveNameDialogOpen(true);
  }, [isAuthenticated, settings, toast]);

  const handleConfirmSaveGangSheet = useCallback(async () => {
    const name = saveNameValue.trim() || `Gang Sheet ${settings.sheetWidth}x${settings.sheetHeight}`;
    setSaveNameDialogOpen(false);
    setIsSaving(true);
    try {
      const pdfBlob = await downloadGangSheetPDF(items, settings, packResult.placements);
      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const saved = await saveGangSheetMutation.mutateAsync({
        name,
        pdfBlob,
        sheetWidth: settings.sheetWidth,
        sheetHeight: settings.sheetHeight,
        itemCount: items.length,
        totalQuantity,
      });
      toast({ title: "Gang sheet saved", description: `"${saved.name}" saved and downloaded.` });
    } catch (error) {
      toast({ title: "Couldn't save gang sheet", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [items, settings, packResult, saveNameValue, saveGangSheetMutation, toast]);

  const currentPreset = GANG_SHEET_PRESETS.find(
    (p) => p.width === settings.sheetWidth && p.height === settings.sheetHeight
  );

  return (
    <div className="bg-[#3a6aa0] rounded-xl border border-white/10 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[#22d3ee]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span className="text-sm font-medium text-[#e8eef6]">Layers</span>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="text-[10px] text-red-300/80 hover:text-red-200 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="px-4 py-3 border-b border-white/10 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[#94a3b8]">Sheet</span>
          <Select
            value={currentPreset?.label || "custom"}
            onValueChange={handlePresetChange}
          >
            <SelectTrigger className="h-8 text-xs w-[7.5rem] bg-[#2d5a8a] border-white/15 text-[#e8eef6]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GANG_SHEET_PRESETS.map((p) => (
                <SelectItem key={p.label} value={p.label}>
                  {p.label}"
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          type="button"
          onClick={handleFillSheet}
          disabled={items.length === 0}
          className="w-full h-10 rounded-lg bg-[#4dff80] hover:bg-[#2ee66a] disabled:opacity-40 text-[#05321a] text-sm font-bold"
          title="Fill remaining space with copies of the last design added"
        >
          Fill Sheet
        </button>
        <div className="text-[11px] text-[#94a3b8]">
          {items.length} design{items.length !== 1 ? "s" : ""} · {placedStickers}
          {placedStickers !== totalStickers ? ` / ${totalStickers}` : ""} sticker{totalStickers !== 1 ? "s" : ""} · {Math.round(packResult.utilization * 100)}% filled
        </div>
      </div>

      {tooBigCount > 0 && (
        <div className="mx-3 mt-3 px-3 py-2 bg-red-500/15 border border-red-400/30 rounded-lg text-xs text-red-200">
          {tooBigCount === 1 ? "Design is too big for this sheet." : `${tooBigCount} designs are too big for this sheet.`}
          {" "}Go back to the designer to resize, or pick a taller sheet.
        </div>
      )}
      {packResult.overflow > 0 && tooBigCount === 0 && (
        <div className="mx-3 mt-3 px-3 py-2 bg-amber-400/15 border border-amber-300/30 rounded-lg text-xs text-amber-100">
          {packResult.overflow} sticker{packResult.overflow !== 1 ? "s" : ""} did not fit. Add copies to auto-expand, or pick a taller sheet.
        </div>
      )}

      <ScrollArea className="max-h-[min(52vh,520px)] px-3 py-3">
        <div className="space-y-2">
          {items.map((item) => {
            const isTooBig = fitInfo.tooBigIds.has(item.id);
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2.5 p-2 rounded-lg border ${
                  isTooBig
                    ? "bg-red-500/15 border-red-400/30"
                    : "bg-[#2d5a8a]/60 border-white/10"
                }`}
              >
                <img
                  src={item.thumbnail}
                  alt="sticker"
                  className="w-11 h-11 object-contain rounded bg-white border border-white/15"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[#e8eef6] truncate">
                    {item.resizeSettings.widthInches.toFixed(1)}" × {item.resizeSettings.heightInches.toFixed(1)}"
                  </div>
                  <div className="text-[10px] text-[#94a3b8] truncate">
                    {item.cutContourLabel}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleQuantityChange(item.id, -1)}
                      className="w-6 h-6 flex items-center justify-center rounded bg-white/10 border border-white/15 text-[#e8eef6] hover:bg-white/20 text-sm font-medium"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!Number.isNaN(val)) handleQuantitySet(item.id, val);
                      }}
                      onFocus={(e) => e.target.select()}
                      className="w-10 h-6 text-center text-xs font-medium text-[#e8eef6] border border-white/15 rounded bg-[#2d5a8a] appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleQuantityChange(item.id, 1)}
                      className="w-6 h-6 flex items-center justify-center rounded bg-white/10 border border-white/15 text-[#e8eef6] hover:bg-white/20 text-sm font-medium"
                    >
                      +
                    </button>
                  </div>
                  {fitWarning?.id === item.id && (
                    <span className="text-[9px] text-amber-300 font-medium">
                      Only {fitWarning.maxFit} fit
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(item.id)}
                  className="w-6 h-6 flex items-center justify-center rounded text-[#94a3b8] hover:text-red-300 hover:bg-red-500/15"
                  title="Remove"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}

          {items.length === 0 && (
            <div className="text-center py-8 px-2">
              <div className="text-sm text-[#94a3b8] mb-1">No stickers yet</div>
              <div className="text-xs text-[#64748b]">
                Go back to the designer and click Add to Gang Sheet.
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-white/10">
        <Button
          onClick={handleExport}
          disabled={isExporting || packResult.placements.length === 0}
          className="w-full h-10 bg-[#4dff80] hover:bg-[#2ee66a] text-[#05321a] font-semibold"
        >
          {isExporting ? "Exporting..." : "Download Gang Sheet PDF"}
        </Button>
        {isAuthenticated && (
          <Button
            onClick={handleSaveGangSheet}
            disabled={isSaving || packResult.placements.length === 0}
            variant="outline"
            className="w-full mt-2 h-10 border-white/20 bg-white/10 text-white hover:bg-white/20"
          >
            {isSaving ? "Saving…" : "Save & Download"}
          </Button>
        )}
      </div>
      <Dialog open={saveNameDialogOpen} onOpenChange={setSaveNameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Name this gang sheet</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={saveNameValue}
            onChange={(e) => setSaveNameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleConfirmSaveGangSheet(); }}
            placeholder="Gang Sheet"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveNameDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleConfirmSaveGangSheet()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
