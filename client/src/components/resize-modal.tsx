import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface ResizeModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (widthInches: number, heightInches: number) => void;
  detectedWidth: number;
  detectedHeight: number;
}

const QUICK_SIZES = [
  { label: '2"', value: 2 },
  { label: '3"', value: 3 },
  { label: '4"', value: 4 },
  { label: '5"', value: 5 },
];

export default function ResizeModal({
  open,
  onClose,
  onConfirm,
  detectedWidth,
  detectedHeight,
}: ResizeModalProps) {
  const aspectRatio = detectedWidth / detectedHeight;

  const [customSize, setCustomSize] = useState("3");

  useEffect(() => {
    if (open) {
      setCustomSize("3");
    }
  }, [open]);

  if (!open) return null;

  const handleSizeSelect = (size: number) => {
    let width: number, height: number;
    if (aspectRatio >= 1) {
      width = size;
      height = size / aspectRatio;
    } else {
      height = size;
      width = size * aspectRatio;
    }
    onConfirm(width, height);
  };

  const handleCustomConfirm = () => {
    const size = parseFloat(customSize);
    if (!isNaN(size) && size >= 0.5) {
      handleSizeSelect(size);
    }
  };

  const handleSkip = () => {
    onConfirm(detectedWidth, detectedHeight);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCustomConfirm();
    }
  };

  const resultingSize = (() => {
    const size = parseFloat(customSize);
    if (!isNaN(size) && size >= 0.5) {
      const w = aspectRatio >= 1 ? size : size * aspectRatio;
      const h = aspectRatio >= 1 ? size / aspectRatio : size;
      return `${w.toFixed(1)}" × ${h.toFixed(1)}"`;
    }
    return null;
  })();

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <h2 className="text-center text-lg font-semibold text-gray-800 mb-1">
          Set sticker size
        </h2>
        <p className="text-sm text-gray-400 text-center mb-6">longest side in inches</p>

        <div className="flex items-center gap-2 mb-1">
          <input
            type="number"
            step="0.25"
            min="0.5"
            max="24"
            value={customSize}
            onChange={(e) => setCustomSize(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 h-12 text-center text-xl font-medium bg-white border-2 border-gray-300 rounded-lg text-gray-700 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none"
            placeholder="Size"
            autoFocus
          />
          <span className="text-xl text-gray-500 font-medium">"</span>
          <Button
            onClick={handleCustomConfirm}
            className="h-12 px-6 bg-cyan-600 hover:bg-cyan-700 text-white font-medium"
          >
            Apply size
          </Button>
        </div>
        {resultingSize && (
          <p className="text-xs text-gray-400 text-center mb-4">
            Resulting size: {resultingSize}
          </p>
        )}
        {!resultingSize && <div className="mb-4" />}

        <div className="flex gap-2 justify-center mb-6">
          {QUICK_SIZES.map((size) => (
            <button
              key={size.value}
              onClick={() => setCustomSize(String(size.value))}
              className={`h-9 px-4 text-sm font-medium rounded-lg border transition-colors ${
                parseFloat(customSize) === size.value
                  ? "bg-cyan-600 border-cyan-600 text-white"
                  : "border-gray-200 text-gray-500 bg-gray-50 hover:bg-cyan-50 hover:border-cyan-300 hover:text-cyan-700"
              }`}
            >
              {size.label}
            </button>
          ))}
        </div>

        <div className="border-t border-gray-100 pt-5">
          <button
            onClick={handleSkip}
            className="w-full py-3.5 text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 border-2 border-gray-200 hover:border-gray-300 rounded-xl transition-colors cursor-pointer"
          >
            Skip — keep current size
            <span className="block text-xs text-gray-400 mt-0.5 font-normal">
              {detectedWidth.toFixed(1)}" × {detectedHeight.toFixed(1)}"
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
