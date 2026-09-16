import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { QRRepairRegion } from "./lib/qr-repair-types";
import { cn } from "@/lib/utils";
import { MousePointer2, ShieldAlert } from "lucide-react";

/**
 * A logo rectangle is deliberately stored relative to the QR patch. This
 * keeps the option independent from the size at which the source artwork is
 * displayed while still allowing the engine to copy the exact source pixels
 * from the selected location.
 */
export type LogoRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type LogoRegionField = keyof LogoRegion;
const LOGO_REGION_FIELDS: Array<[LogoRegionField, string]> = [
  ["x", "X position (%)"],
  ["y", "Y position (%)"],
  ["width", "Width (%)"],
  ["height", "Height (%)"],
];
const EMPTY_LOGO_REGION: LogoRegion = { x: 0, y: 0, width: 0, height: 0 };

export interface LogoRegionSelectorProps {
  /** The retained source image. Never replace this with an upload blob URL. */
  image: HTMLImageElement;
  /** Source-pixel rectangle of the QR patch being rebuilt. */
  draftRegion: QRRepairRegion;
  /** Normalized rectangle relative to draftRegion, or undefined until drawn. */
  value?: LogoRegion;
  onChange: (region?: LogoRegion) => void;
  onAvailabilityChange?: (available: boolean) => void;
  disabled?: boolean;
  className?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sourceDimensions(image: HTMLImageElement) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

function normalizedPoint(
  event: ReactPointerEvent<HTMLDivElement>,
  element: HTMLDivElement,
): { x: number; y: number } | null {
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function pixelAlignedRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
): LogoRegion {
  // Align the interaction to source pixels. The engine can then use the
  // normalized values to reconstruct the same source rectangle without
  // resampling or silently changing its location.
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  const x = Math.round(left * sourceWidth);
  const y = Math.round(top * sourceHeight);
  const rightPixel = Math.round(right * sourceWidth);
  const bottomPixel = Math.round(bottom * sourceHeight);
  return {
    x: clamp(x, 0, sourceWidth) / Math.max(1, sourceWidth),
    y: clamp(y, 0, sourceHeight) / Math.max(1, sourceHeight),
    width: clamp(rightPixel - x, 0, sourceWidth - x) / Math.max(1, sourceWidth),
    height: clamp(bottomPixel - y, 0, sourceHeight - y) / Math.max(1, sourceHeight),
  };
}

function validLogoRegion(region: LogoRegion | undefined) {
  if (!region) return false;
  const values = [region.x, region.y, region.width, region.height];
  return values.every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1 &&
    region.y + region.height <= 1;
}

export function LogoRegionSelector({
  image,
  draftRegion,
  value,
  onChange,
  onAvailabilityChange,
  disabled = false,
  className,
}: LogoRegionSelectorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);
  const pointerPreviousValue = useRef<LogoRegion | undefined>(value);
  const pointerRegion = useRef<LogoRegion | undefined>(value);
  const [dragging, setDragging] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [percentageInputValues, setPercentageInputValues] = useState<Record<LogoRegionField, string>>({
    x: "0",
    y: "0",
    width: "0",
    height: "0",
  });
  const [percentageValidationError, setPercentageValidationError] = useState<string | null>(null);

  useEffect(() => {
    pointerRegion.current = value;
  }, [value]);

  useEffect(() => {
    const canvas = canvasRef.current;
    let active = true;
    onAvailabilityChange?.(false);
    setDrawError(null);
    if (!canvas || draftRegion.width <= 0 || draftRegion.height <= 0) {
      setDrawError("The selected QR region has no usable dimensions.");
      return () => {
        active = false;
      };
    }
    const maxEdge = 1200;
    const scale = Math.min(1, maxEdge / Math.max(draftRegion.width, draftRegion.height));
    const width = Math.max(1, Math.round(draftRegion.width * scale));
    const height = Math.max(1, Math.round(draftRegion.height * scale));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setDrawError("The browser could not create a canvas for this logo crop.");
      return () => {
        active = false;
      };
    }
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;
    try {
      const dimensions = sourceDimensions(image);
      if (
        !dimensions.width ||
        !dimensions.height ||
        draftRegion.x < 0 ||
        draftRegion.y < 0 ||
        draftRegion.x + draftRegion.width > dimensions.width ||
        draftRegion.y + draftRegion.height > dimensions.height
      ) {
        throw new Error("The selected QR region is outside the retained artwork.");
      }
      // This canvas is a bounded crop from the retained image element. It
      // avoids making a new <img> that could point at a revoked blob URL.
      context.drawImage(
        image,
        draftRegion.x,
        draftRegion.y,
        draftRegion.width,
        draftRegion.height,
        0,
        0,
        width,
        height,
      );
      if (active) onAvailabilityChange?.(true);
    } catch (error) {
      if (active) {
        onAvailabilityChange?.(false);
        setDrawError(
          error instanceof Error
            ? `Unable to render the retained logo crop: ${error.message}`
            : "Unable to render the retained logo crop.",
        );
      }
    }
    return () => {
      active = false;
    };
  }, [draftRegion, image, onAvailabilityChange]);

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = selectorRef.current;
    const start = pointerStart.current;
    const dimensions = sourceDimensions(image);
    if (disabled || drawError || !element || !start || !dimensions.width || !dimensions.height) return;
    const point = normalizedPoint(event, element);
    if (!point) return;
    const next = pixelAlignedRegion(
      start,
      point,
      Math.max(1, draftRegion.width),
      Math.max(1, draftRegion.height),
    );
    pointerRegion.current = next;
    if (validLogoRegion(next)) setPercentageValidationError(null);
    onChange(next);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || drawError || pointerStart.current || event.button !== 0) return;
    const element = selectorRef.current;
    if (!element) return;
    const point = normalizedPoint(event, element);
    if (!point) return;
    event.preventDefault();
    try {
      element.setPointerCapture(event.pointerId);
      pointerId.current = event.pointerId;
    } catch {
      setDrawError("The browser could not capture this selection gesture. Try drawing again.");
      return;
    }
    pointerStart.current = point;
    pointerPreviousValue.current = value;
    const empty: LogoRegion = { x: point.x, y: point.y, width: 0, height: 0 };
    pointerRegion.current = empty;
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || drawError || !pointerStart.current || pointerId.current !== event.pointerId) return;
    event.preventDefault();
    updateFromPointer(event);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || drawError || !pointerStart.current || pointerId.current !== event.pointerId) return;
    updateFromPointer(event);
    pointerStart.current = null;
    setDragging(false);
    if (pointerId.current !== null && event.currentTarget.hasPointerCapture(pointerId.current)) {
      event.currentTarget.releasePointerCapture(pointerId.current);
    }
    pointerId.current = null;
  };

  const cancelPointer = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerStart.current) return;
    if (event && pointerId.current !== event.pointerId) return;
    const element = event?.currentTarget ?? selectorRef.current;
    const activePointerId = pointerId.current;
    pointerStart.current = null;
    pointerId.current = null;
    pointerRegion.current = pointerPreviousValue.current;
    setDragging(false);
    if (validLogoRegion(pointerPreviousValue.current)) setPercentageValidationError(null);
    if (element && activePointerId !== null && element.hasPointerCapture(activePointerId)) {
      element.releasePointerCapture(activePointerId);
    }
    onChange(pointerPreviousValue.current);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    cancelPointer(event);
  };

  // If Apply/Close disables the selector while a pointer is held, release the
  // capture and restore the pre-drag rectangle. A disabled component must not
  // commit one last pointer coordinate.
  useEffect(() => {
    if (!disabled && !drawError) return;
    cancelPointer();
  }, [disabled, drawError]);

  useEffect(() => {
    if (drawError) onAvailabilityChange?.(false);
  }, [drawError, onAvailabilityChange]);

  const selected = validLogoRegion(value) ? value : undefined;
  const inputRegion = value ?? pointerRegion.current ?? EMPTY_LOGO_REGION;
  const current = dragging ? pointerRegion.current : selected;
  const currentRegion = validLogoRegion(current) ? current : undefined;

  useEffect(() => {
    if (dragging) return;
    setPercentageInputValues(
      LOGO_REGION_FIELDS.reduce(
        (values, [field]) => ({
          ...values,
          [field]: Number((inputRegion[field] * 100).toFixed(2)).toString(),
        }),
        {} as Record<LogoRegionField, string>,
      ),
    );
  }, [dragging, value]);

  const updatePercentage = (field: LogoRegionField, rawValue: string) => {
    setPercentageInputValues((previous) => ({ ...previous, [field]: rawValue }));
    const percentage = Number(rawValue);
    if (!Number.isFinite(percentage)) return;
    const next = {
      ...inputRegion,
      [field]: clamp(percentage / 100, 0, 1),
    };
    if (
      next.x + next.width > 1 ||
      next.y + next.height > 1
    ) {
      setPercentageValidationError("Logo rectangle must stay within the QR crop. Adjust x/y or width/height.");
      // Keep the invalid normalized rectangle in the draft so the tested
      // signature is cleared and Apply cannot silently reuse stale output.
      onChange(next);
      return;
    }
    setPercentageValidationError(null);
    onChange(next);
  };

  const percentageMax = (field: LogoRegionField) => {
    if (field === "x") return Math.max(0, (1 - inputRegion.width) * 100);
    if (field === "y") return Math.max(0, (1 - inputRegion.height) * 100);
    if (field === "width") return Math.max(0, (1 - inputRegion.x) * 100);
    return Math.max(0, (1 - inputRegion.y) * 100);
  };

  return (
    <div className={cn("mt-3", className)}>
      <div
        ref={selectorRef}
        className={cn(
          "relative mx-auto w-full touch-none overflow-hidden rounded-lg border border-sky-700/70 bg-slate-950",
          disabled || drawError ? "cursor-not-allowed opacity-60" : "cursor-crosshair",
        )}
        style={{ maxWidth: 256 * draftRegion.width / Math.max(1, draftRegion.height) }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={handleLostPointerCapture}
        role="application"
        aria-label="Logo region selector. Draw or redraw a rectangle around the logo."
      >
        <canvas
          ref={canvasRef}
          className="block h-auto max-h-64 w-full select-none [image-rendering:auto]"
          aria-label="Cropped QR artwork for logo selection"
        />
        {drawError ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-slate-950/90 px-3 text-center text-[11px] leading-4 text-rose-200"
          >
            Logo selection unavailable. Selection is disabled until the retained artwork can be rendered.
            <span className="text-[10px] text-rose-200/80">{drawError}</span>
          </div>
        ) : null}
        {currentRegion ? (
          <div
            className="pointer-events-none absolute rounded border-2 border-fuchsia-300 bg-fuchsia-300/20 shadow-[0_0_0_1px_rgba(232,121,249,0.35)]"
            style={{
              left: `${currentRegion.x * 100}%`,
              top: `${currentRegion.y * 100}%`,
              width: `${currentRegion.width * 100}%`,
              height: `${currentRegion.height * 100}%`,
            }}
            aria-hidden="true"
          >
            <span className="absolute -top-5 left-0 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-100">
              Kept logo
            </span>
          </div>
        ) : null}
        {!selected ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded bg-slate-950/85 px-2 py-1 text-[10px] text-slate-300">
            <MousePointer2 className="h-3 w-3 text-fuchsia-300" aria-hidden="true" />
            Draw a rectangle around the logo
          </div>
        ) : null}
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-amber-200/90">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        A logo near a corner can cover a QR recognition square and block repair. We will not move, shrink, or remove your selection.
      </p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">
        Drag anywhere in the crop to draw or redraw its exact source location and size.
      </p>
      <fieldset
        disabled={disabled || Boolean(drawError)}
        className="mt-3 rounded-lg border border-slate-800 bg-slate-950/35 p-2"
      >
        <legend className="px-1 text-[11px] font-medium text-slate-300">Enter logo coordinates (%)</legend>
        <p className="mb-2 text-[10px] leading-4 text-slate-500">
          Keyboard users can enter the same normalized source rectangle. Values are percentages of the QR crop.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {LOGO_REGION_FIELDS.map(([field, label]) => (
            <div key={field}>
              <label htmlFor={`logo-region-${field}`} className="mb-1 block text-[10px] text-slate-400">
                {label}
              </label>
              <input
                id={`logo-region-${field}`}
                type="number"
                min={0}
                max={percentageMax(field)}
                step={0.01}
                value={percentageInputValues[field]}
                onChange={(event) => updatePercentage(field, event.target.value)}
                onBlur={() => {
                  if (!percentageValidationError) {
                    setPercentageInputValues((previous) => ({
                      ...previous,
                      [field]: Number((inputRegion[field] * 100).toFixed(2)).toString(),
                    }));
                  }
                }}
                className="h-8 w-full rounded-md border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                aria-label={label}
              />
            </div>
          ))}
        </div>
        {percentageValidationError ? (
          <p role="alert" className="mt-2 text-[10px] leading-4 text-rose-300">
            {percentageValidationError}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

export default LogoRegionSelector;