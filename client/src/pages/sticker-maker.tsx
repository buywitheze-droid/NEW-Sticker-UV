import { useState } from "react";
import ImageEditor from "@/builders/spot-uv/image-editor";
import AccountMenu from "@/components/account-menu";

export default function StickerMaker() {
  const [designUploaded, setDesignUploaded] = useState(false);
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#2d5a8a" }}>
      <header
        className="backdrop-blur-md border-b border-white/10 px-6 py-3.5 sticky top-0 z-40"
        style={{ backgroundColor: "rgba(36, 78, 122, 0.95)" }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between" style={{ minHeight: "28px" }}>
          <div className="w-8" aria-hidden="true" />
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#4dff80] to-[#12b35a] flex items-center justify-center shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                <path d="M8 12h8" />
                <path d="M12 8v8" />
              </svg>
            </div>
            <h1
              className="text-xl text-white font-bold tracking-tight"
              style={{ fontFamily: "'Georgia', 'Times New Roman', serif", letterSpacing: "-0.02em" }}
            >
              AnyContour
            </h1>
          </div>
          <AccountMenu />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
        <ImageEditor
          mode="gangsheet"
          enableSpotColors
          onDesignUploaded={() => setDesignUploaded(true)}
        />
      </main>
    </div>
  );
}
