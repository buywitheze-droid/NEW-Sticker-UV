import ImageEditor from "@/builders/spot-uv/image-editor";

export default function EmbedPage() {
  return (
    <div className="w-full h-[800px] max-h-screen overflow-hidden" style={{ backgroundColor: "#2d5a8a" }}>
      <div className="w-full h-full p-2">
        <ImageEditor mode="gangsheet" enableSpotColors />
      </div>
    </div>
  );
}
